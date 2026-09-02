/* ============================================================
   AI 代理（v0.12）：POST /api/ai/chat
   - 代理转发到质谱 AI（GLM-4-Flash，OpenAI 兼容接口）
   - Key 来源：请求头 X-AI-Key（设置页填写的个人 Key）或
     环境变量 ZHIPU_API_KEY（部署端全局 Key），后者优先
   ============================================================ */
const ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";

exports.default = async (req) => {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 20) : [];
  if (!messages.length) return json({ error: "Missing messages" }, 400);

  const apiKey = process.env.ZHIPU_API_KEY || (req.headers.get("x-ai-key") || "").trim();
  if (!apiKey) {
    return json({ error: "未配置 API Key：请在设置页填写，或部署环境变量 ZHIPU_API_KEY" }, 400);
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: Number.isFinite(body.temperature) ? body.temperature : 0.7,
        max_tokens: Math.min(parseInt(body.max_tokens, 10) || 400, 2000),
        stream: false,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = (data && (data.error && (data.error.message || data.error.code))) || `AI 服务错误 HTTP ${res.status}`;
      return json({ error: String(msg) }, res.status === 401 ? 401 : 502);
    }
    return json(data);
  } catch (e) {
    return json({ error: "AI 服务不可达：" + (e && e.message ? e.message : e) }, 502);
  }
};

exports.config = { path: "/api/ai/chat" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
