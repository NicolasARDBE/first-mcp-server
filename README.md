# first-mcp-server

A simple MCP (Model Context Protocol) server implemented in TypeScript.

## Features
- TypeScript-based server
- API tool integration
- Easy to extend and customize

## Getting Started

### Prerequisites
- Node.js (v16 or higher recommended)
- npm

### Installation
```bash
git clone https://github.com/NicolasARDBE/first-mcp-server.git
cd first-mcp-server
npm install
```

### Build
```bash
npm run build
```

### Run
#### Stdio:
```bash
npx @modelcontextprotocol/inspector node build/index.js
```
#### Https server:
```bash
npx node build/https-server.js
```
### 🔌 Connect with MCP Client

To connect an MCP client (like an LLM) to your MCP server, create a file called **`MCP.json`** and register your servers.

#### Example `MCP.json`

```json
{
  "servers": {
    "firstServer": {
      "command": "node",
      "args": ["C:\\MCP\\calculator-server\\src\\index.ts"]
    },
    "firstHttpsServer": {
      "url": "http://localhost:3000/mcp",
      "type": "http"
    }
  },
  "inputs": []
}
```

## Contributing
Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.