# 1) Build
FROM node:20-alpine AS build
WORKDIR /app

# Copia apenas o package do subprojeto
COPY piperun-mcp-server/package*.json ./piperun-mcp-server/
WORKDIR /app/piperun-mcp-server
RUN npm ci

# Copia o código e compila
COPY piperun-mcp-server/ ./
RUN npm run build

# 2) Runtime
FROM node:20-alpine AS run
WORKDIR /app/piperun-mcp-server

# Copia artefatos e deps
COPY --from=build /app/piperun-mcp-server /app/piperun-mcp-server

# Instala o supergateway para expor STDIO -> SSE
RUN npm i -g supergateway

# Porta do proxy (você pode trocar para 8000/8080)
ENV PORT=8080
EXPOSE 8080

# Supergateway: stdio -> SSE
# - /sse (GET) e /message (POST)
# - health em /healthz retorna "ok"
CMD ["sh", "-lc", "supergateway --stdio \"node build/index.js\" --port ${PORT} --ssePath /sse --messagePath /message --healthEndpoint /healthz --baseUrl http://localhost:${PORT}"]
