import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = process.env.HR_CHATBOT_HOST || "127.0.0.1";
const PORT = Number(process.env.HR_CHATBOT_PORT || 8787);
const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const KEY_FILE = process.env.OPENAI_API_KEY_FILE || "/etc/openai-api-key";
const LOG_FILE = process.env.HR_CHATBOT_USAGE_LOG || "/var/log/hr-text-chatbot-usage.log";
const DATA_DIR = process.env.HR_CHATBOT_DATA_DIR || "/var/www/html/data";
const INPUT_PRICE_PER_MILLION = Number(process.env.OPENAI_INPUT_PRICE_PER_MILLION || 0.75);
const CACHED_INPUT_PRICE_PER_MILLION = Number(process.env.OPENAI_CACHED_INPUT_PRICE_PER_MILLION || 0.075);
const OUTPUT_PRICE_PER_MILLION = Number(process.env.OPENAI_OUTPUT_PRICE_PER_MILLION || 4.5);
const KNOWLEDGE_FILES = [
  "보수 및 퇴직금 규정.hwpforge.md",
  "시간외근무 실시 기준.hwpforge.md",
  "인사규정 시행세칙.hwpforge.md",
  "인사규정.hwpforge.md",
  "취업규정.hwpforge.md"
];

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readJson(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function apiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  try {
    return readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function truncate(value, max) {
  return String(value || "").slice(0, max);
}

function revisionKey(name) {
  const match = String(name).match(/(\d{4})년(?:도)?\s*(\d{1,2})월(?:\s*(\d{1,2})일)?/);
  if (!match) return "bada.ai/data";
  return [
    match[1],
    match[2].padStart(2, "0"),
    (match[3] || "01").padStart(2, "0")
  ].join("-");
}

function sourceList() {
  return KNOWLEDGE_FILES.map((file) => ({
    file,
    revision: revisionKey(file),
    title: file.replace(/\.hwpforge\.md$/, "")
  }));
}

function documentsForSelection(selectedFiles, selectedRevision = "all") {
  const allowedFiles = new Set(KNOWLEDGE_FILES);
  const requestedFiles = Array.isArray(selectedFiles)
    ? selectedFiles.filter((file) => allowedFiles.has(file))
    : [];
  const requestedSet = new Set(requestedFiles);

  return sourceList()
    .filter((source) => {
      if (requestedSet.size) return requestedSet.has(source.file);
      return selectedRevision === "all" || source.revision === selectedRevision;
    })
    .map((source, index) => ({
      id: index + 1,
      source: truncate(source.file, 240),
      revision: source.revision,
      text: readFileSync(join(DATA_DIR, source.file), "utf8")
    }));
}

function outputText(responseJson) {
  let text = "";
  for (const output of responseJson.output || []) {
    for (const content of output.content || []) {
      if (content.type === "output_text") text += content.text || "";
    }
  }
  return text;
}

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const unwrapped = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(unwrapped);
  } catch {}

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  return null;
}

function publicOpenAiRequest(body) {
  const publicBody = structuredClone(body);
  try {
    const input = JSON.parse(publicBody.input);
    if (Array.isArray(input.documents)) {
      input.documents = input.documents.map((doc) => ({
        ...doc,
        text: `[server-side Markdown omitted: ${String(doc.text || "").length} characters]`
      }));
    }
    publicBody.input = JSON.stringify(input);
  } catch {
    publicBody.input = "[server-side input omitted]";
  }

  return {
    endpoint: "POST https://api.openai.com/v1/responses",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer [server-side API key hidden]"
    },
    body: publicBody
  };
}

function usageCost(decoded) {
  const usage = decoded.usage;
  if (!usage) return null;

  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens);
  const cachedInputTokens = Number(usage.input_tokens_details?.cached_tokens || 0);
  const billableInputTokens = Math.max(inputTokens - cachedInputTokens, 0);
  const inputCost = billableInputTokens * INPUT_PRICE_PER_MILLION / 1_000_000;
  const cachedInputCost = cachedInputTokens * CACHED_INPUT_PRICE_PER_MILLION / 1_000_000;
  const outputCost = outputTokens * OUTPUT_PRICE_PER_MILLION / 1_000_000;
  const totalCost = inputCost + cachedInputCost + outputCost;

  return {
    model: MODEL,
    currency: "USD",
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    billable_input_tokens: billableInputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_cost: Number(inputCost.toFixed(8)),
    cached_input_cost: Number(cachedInputCost.toFixed(8)),
    output_cost: Number(outputCost.toFixed(8)),
    total_cost: Number(totalCost.toFixed(8)),
    rates_per_million: {
      input: INPUT_PRICE_PER_MILLION,
      cached_input: CACHED_INPUT_PRICE_PER_MILLION,
      output: OUTPUT_PRICE_PER_MILLION
    }
  };
}

function logUsage(decoded, meta) {
  const usage = decoded.usage;
  if (!usage) return;
  const cost = usageCost(decoded);
  const entry = {
    at: new Date().toISOString(),
    model: MODEL,
    question: meta.question.slice(0, 160),
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    total_cost_usd: cost?.total_cost ?? null
  };
  try {
    appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
  } catch {
    // Logging must never break the user-facing answer.
  }
}

async function openaiAnswer(input) {
  const question = String(input.question || "").trim();
  const selectedRevision = String(input.revision || "all");
  const documents = documentsForSelection(input.documents, selectedRevision);
  if (!question || documents.length === 0 || documents.every((doc) => !doc.text.trim())) {
    return { status: 400, payload: { error: "Question and documents are required" } };
  }

  const key = apiKey();
  if (!key) {
    return { status: 503, payload: { error: "OPENAI_API_KEY is not configured on the server" } };
  }

  const prompt = {
    question,
    documents,
    response_contract: {
      answer: "Korean answer. Search the full Markdown document and apply the cited HR rule to the question. Do not use outside facts.",
      reasoning_steps: "3 to 5 short Korean bullet-style steps. Show applied rule, condition, exception, and conclusion. Do not reveal hidden chain-of-thought.",
      citations: "Array of Korean article titles, page labels, or document ids used.",
      evidence: "1 to 4 relevant original regulation passages copied from the provided Markdown document.",
      caveats: "Array of Korean caveats when text is OCR-noisy, ambiguous, or needs another policy."
    }
  };

  const body = {
    model: MODEL,
    store: false,
    reasoning: { effort: "low" },
    max_output_tokens: 5000,
    text: {
      format: {
        type: "json_schema",
        name: "hr_reasoning_answer",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            answer: { type: "string" },
            reasoning_steps: { type: "array", items: { type: "string" } },
            citations: { type: "array", items: { type: "string" } },
            evidence: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  source: { type: "string" },
                  revision: { type: "string" },
                  excerpt: { type: "string" }
                },
                required: ["title", "source", "revision", "excerpt"]
              }
            },
            caveats: { type: "array", items: { type: "string" } }
          },
          required: ["answer", "reasoning_steps", "citations", "evidence", "caveats"]
        },
        strict: true
      }
    },
    instructions: [
      "You are an HR regulation reasoning assistant.",
      "Answer in Korean.",
      "Use only the provided full Markdown documents. If the documents are insufficient, say what is missing.",
      "Find the relevant article, clause, condition, exception, and date directly from the document text.",
      "Return evidence excerpts copied verbatim from the document text so the user can inspect the original regulation wording.",
      "Keep each evidence excerpt focused and under 1200 characters.",
      "Reason about eligibility, periods, exceptions, and HR consequences, but keep the reasoning summary concise.",
      "Do not invent article numbers, dates, or exceptions."
    ].join("\n"),
    input: JSON.stringify(prompt)
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const decoded = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        status: 502,
        payload: { error: decoded?.error?.message || `OpenAI API returned HTTP ${response.status}` }
      };
    }

    logUsage(decoded, { question });
    const parsed = parseModelJson(outputText(decoded));
    if (!parsed?.answer) {
      return {
        status: 502,
        payload: {
          error: "OpenAI response was not valid JSON",
          details: decoded?.incomplete_details?.reason || decoded?.status || "unknown"
        }
      };
    }
    return {
      status: 200,
      payload: {
        ...parsed,
        usage_cost: usageCost(decoded),
        openai_request: publicOpenAiRequest(body),
        openai_response: decoded
      }
    };
  } catch (error) {
    return {
      status: 502,
      payload: { error: `OpenAI request failed: ${error.name === "AbortError" ? "timeout" : error.message}` }
    };
  } finally {
    clearTimeout(timeout);
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && (req.url === "/sources" || req.url === "/api/sources")) {
    json(res, 200, { sources: sourceList() });
    return;
  }
  if (req.method !== "POST" || req.url !== "/api") {
    json(res, 404, { error: "Not found" });
    return;
  }

  try {
    const input = await readJson(req);
    const result = await openaiAnswer(input);
    json(res, result.status, result.payload);
  } catch (error) {
    json(res, /large|Invalid JSON/.test(error.message) ? 400 : 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`hr-text-chatbot API listening on http://${HOST}:${PORT}`);
});
