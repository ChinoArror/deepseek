addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// 加密密钥（建议存储在环境变量）
const ENCRYPTION_KEY = 'c6aad780c6dae2674bd5e897e2a82027'; // 需替换为真实密钥

async function handleRequest(request) {
  // 处理预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    })
  }

  // 返回前端界面
  if (request.method === 'GET' && !request.url.includes('/history')) {
    return new Response(HTML, {
      headers: { 'Content-Type': 'text/html' }
    })
  }

  // 获取对话历史
  if (request.method === 'GET' && request.url.includes('/history')) {
    try {
      const clientIP = request.headers.get('CF-Connecting-IP') || 'anonymous'
      const list = await CHAT_HISTORY.list({ prefix: `hist_${clientIP}_` })
      
      const histories = await Promise.all(
        list.keys.map(async (key) => ({
          id: key.name,
          data: await decryptData(await CHAT_HISTORY.get(key.name, 'arrayBuffer'))
        }))
      )
      
      return new Response(JSON.stringify(histories), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  // 处理对话请求
  if (request.method === 'POST') {
    try {
      const payload = await request.json()
      const clientIP = request.headers.get('CF-Connecting-IP') || 'anonymous'
      const sessionId = Date.now()
      
      // 加密存储
      const encryptedData = await encryptData(
        JSON.stringify(payload.messages),
        await getCryptoKey(ENCRYPTION_KEY)
      )
      
      await CHAT_HISTORY.put(
        `hist_${clientIP}_${sessionId}`,
        encryptedData,
        { expirationTtl: 604800 } // 7天过期
      )

      // 转发到DeepSeek API
      const apiResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: payload.messages,
          temperature: 0.7
        })
      })

      const data = await apiResponse.json()
      
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  return new Response('Not Found', { status: 404 })
}

// 加密工具函数
async function getCryptoKey(key) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encryptData(text, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(text)
  )
  return JSON.stringify({
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted))
  })
}

async function decryptData(encryptedData) {
  try {
    const { iv, data } = JSON.parse(new TextDecoder().decode(encryptedData))
    const key = await getCryptoKey(ENCRYPTION_KEY)
    
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(data)
    )
    
    return JSON.parse(new TextDecoder().decode(decrypted))
  } catch (error) {
    console.error('Decryption failed:', error)
    return null
  }
}

// 前端界面（包含历史展示）
const HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>DeepSeek Chat</title>
  <style>
    /* 原有样式基础上增加历史面板样式 */
    .history-panel {
      width: 250px;
      border-right: 1px solid #ddd;
      padding: 15px;
      overflow-y: auto;
    }
    .history-item {
      padding: 10px;
      margin-bottom: 10px;
      border-radius: 5px;
      cursor: pointer;
      background: #f8f9fa;
      transition: background 0.2s;
    }
    .history-item:hover {
      background: #e9ecef;
    }
    .container {
      display: flex;
    }
    .chat-area {
      flex: 1;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="history-panel" id="historyPanel">
      <h3>对话历史</h3>
    </div>
    <div class="chat-area">
      <div id="chatBox"></div>
      <div class="input-area">
        <textarea id="userInput" placeholder="输入你的问题..."></textarea>
        <button onclick="sendMessage()">发送</button>
      </div>
    </div>
  </div>
  <script>
    // 原有消息发送逻辑基础上增加历史功能
    async function loadHistory() {
      try {
        const response = await fetch('/history')
        const histories = await response.json()
        
        const historyList = histories
  .filter(h => h.data)
  .map(h => `
    <div class="history-item" onclick="loadSession('${h.id.replace(/'/g, "\\'")}')">
      <small>${new Date(parseInt(h.id.split('_')[2], 10)).toLocaleString()}</small>
      <p>${h.data[0]?.content?.substring(0, 30) || '无内容'}...</p>
    </div>
  `).join('');
  
        document.getElementById('historyPanel').innerHTML = historyList
      } catch (error) {
        console.error('加载历史失败:', error)
      }
    }

    async function loadSession(sessionId) {
      try {
        const response = await fetch('/history')
        const histories = await response.json()
        const session = histories.find(h => h.id === sessionId)
        
        if (session?.data) {
          document.getElementById('chatBox').innerHTML = session.data
            .map(msg => `
              <div class="message ${msg.role === 'user' ? 'user-message' : 'bot-message'}">
                <strong>${msg.role === 'user' ? '你' : 'AI'}:</strong>
                <p>${msg.content}</p>
              </div>
            `).join('')
        }
      } catch (error) {
        console.error('加载会话失败:', error)
      }
    }

    // 初始化加载历史
    window.onload = loadHistory
    // 原有sendMessage函数保持不变...
  </script>
</body>
</html>
`;
