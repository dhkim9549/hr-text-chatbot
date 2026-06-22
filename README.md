# HR Text Chatbot

Korean HR regulation chatbot for `bada.ai/report/hr-text-chatbot/`.

The app serves a static HTML frontend and a small Node.js API proxy. The API reads HwpForge-generated Markdown files from `data/`, sends the selected documents and user question to the OpenAI Responses API, and returns an answer with citations, evidence excerpts, token usage, and estimated cost.

## Files

- `index.html` - frontend UI.
- `live-index.html` - deployed frontend variant.
- `server.mjs` - Node.js API server.
- `apache-hr-text-chatbot.conf` - Apache proxy/static-data configuration.
- `hr-text-chatbot.service` - systemd service example.
- `data/*.hwpforge.md` - Markdown knowledge files.
- `data/viewer.html` - Markdown source viewer.

## Run

```bash
OPENAI_API_KEY=sk-... HR_CHATBOT_DATA_DIR="$PWD/data" node server.mjs
```

The API listens on `127.0.0.1:8787` by default.

## Environment

- `OPENAI_API_KEY` or `OPENAI_API_KEY_FILE`
- `OPENAI_MODEL`
- `HR_CHATBOT_HOST`
- `HR_CHATBOT_PORT`
- `HR_CHATBOT_DATA_DIR`
- `HR_CHATBOT_USAGE_LOG`

Do not commit API keys, usage logs, or private source documents unless they are intended to be public.
