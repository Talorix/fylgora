# Fylgora

**Node (daemon) for lightweight game server management by Talorix**

---
if you are switching from talon to fylgora please check [Note4TalonUsers.md](https://github.com/Talorix/fylgora/blob/main/Note4TalonUsers.md)

## Prerequisites

Before installing Fylgora, make sure you have the following dependencies installed:

- [Docker](https://www.docker.com/get-started/)
- [Node.js v18+](https://nodejs.org/en/download/)

---

## Installation

1. **Clone the repository:**  
   ```bash
   git clone https://github.com/talorix/fylgora.git
   ```

2. **Navigate to the project folder:**

   ```bash
   cd fylgora
   ```

3. **Install dependencies:**

   ```bash
   npm install
   ```

4. **Configure your node:**
   Go to your panel, create a node, copy the configuration command, and paste it into your terminal.

---

## Build

Building fylgora:

```bash
npx tsc 
```

## Start

To start the Fylgora node:

```bash
node dist/index.js
```

Your node should now be running and ready to manage game servers.
