import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { startServer: startBinding } = require("../../receiver/test/binding-server");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist", "index.html");

// Built once per run: every test loads the same artifact the firmware embeds.
let html = null;
export function page() {
  if (html === null) {
    execFileSync("node", [path.join(HERE, "..", "build.js")], { stdio: "inherit" });
    html = fs.readFileSync(DIST, "utf8");
  }
  return html;
}

export function startServer(opts = {}) {
  return startBinding(Object.assign({}, opts, { html: page() }));
}

// Serves the bundle and nothing else. A dashboard with no configured sources
// reads the origin it was served from, so this doubles as that origin's source
// when `origin` is given.
export function startPage(opts = {}) {
  const body = page();
  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0] !== "/") {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(body);
  });
  const sockets = new Set();
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port + "/",
        close() {
          for (const s of sockets) s.destroy();
          return new Promise(done => server.close(done));
        },
      });
    });
  });
}
