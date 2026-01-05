# 1) Build
FROM node:20-alpine AS build
WORKDIR /app

# Copia apenas o package do subprojeto
COPY piperun-mcp-server/package*.json ./piperun-mcp-server/
WORKDIR /app/piperun-mcp-server
RUN npm ci --ignore-scripts

# Copia o código e compila
COPY piperun-mcp-server/ ./
RUN npm run build

# 2) Runtime
FROM node:20-alpine AS run
WORKDIR /app/piperun-mcp-server

COPY --from=build /app/piperun-mcp-server /app/piperun-mcp-server

RUN npm i -g supergateway

# EasyPanel costuma injetar PORT=80; vamos usar isso como padrão.
ENV PORT=80
EXPOSE 80

# Supergateway: stdio -> Streamable HTTP
# Endpoint padrão: /mcp
# Health: /healthz
CMD ["sh", "-lc", "supergateway --stdio \"node build/index.js\" --outputTransport streamableHttp --port ${PORT} --streamableHttpPath /mcp --healthEndpoint /healthz --baseUrl http://localhost:${PORT}"]
