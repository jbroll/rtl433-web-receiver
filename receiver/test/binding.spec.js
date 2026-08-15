const { test, expect } = require("@playwright/test");
const http = require("http");
const { startServer } = require("./binding-server");
const { ACURITE, OREGON, SOURCE, topicOf } = require("./fixtures");

let server;

test.afterEach(async () => { if (server) await server.close(); server = null; });

// Collects SSE frames from a raw request, since the tests run in node rather
// than in a page.
function openStream(url, query) {
  return new Promise(resolve => {
    const req = http.get(url.replace(/\/$/, "") + "/events" + (query || ""), res => {
      const frames = [];
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        buf += chunk;
        let at;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const line = block.split("\n").find(l => l.startsWith("data: "));
          if (line) frames.push(JSON.parse(line.slice(6)));
        }
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        frames: frames,
        async settle() { await new Promise(r => setTimeout(r, 150)); return frames; },
        close() { req.destroy(); },
      });
    });
    req.on("error", () => {});
  });
}

test("a topic with no message is 404 and a stored one returns its body", async () => {
  server = await startServer({ devices: [ACURITE] });
  const missing = await server.get(SOURCE + "/Nothing/1");
  expect(missing.status).toBe(404);

  const found = await server.get(topicOf(ACURITE));
  expect(found.status).toBe(200);
  expect(found.headers["content-type"]).toContain("application/json");
  expect(JSON.parse(found.body).model).toBe("Acurite-5n1");
});

test("a posted alias comes back byte for byte", async () => {
  server = await startServer({ devices: [ACURITE] });
  const topic = topicOf(ACURITE) + "/$alias";
  expect((await server.get(topic)).status).toBe(404);

  expect((await server.post(topic, JSON.stringify("Back fence"))).status).toBe(204);
  const got = await server.get(topic);
  expect(got.status).toBe(200);
  expect(got.body).toBe(JSON.stringify("Back fence"));
});

test("every response allows any origin, and a preflight is 204", async () => {
  server = await startServer({ devices: [ACURITE] });
  const got = await server.get(topicOf(ACURITE));
  expect(got.headers["access-control-allow-origin"]).toBe("*");

  const pre = await server.options(topicOf(ACURITE) + "/$alias");
  expect(pre.status).toBe(204);
  expect(pre.headers["access-control-allow-methods"]).toContain("POST");
});

test("a post of a non-JSON body is 400 and leaves the alias alone", async () => {
  server = await startServer({ devices: [ACURITE] });
  const topic = topicOf(ACURITE) + "/$alias";
  await server.post(topic, JSON.stringify("Back fence"));

  expect((await server.post(topic, "not json at all")).status).toBe(400);
  expect((await server.post(topic, JSON.stringify({ name: "x" }))).status).toBe(400);
  expect((await server.get(topic)).body).toBe(JSON.stringify("Back fence"));
});

test("a post to a non-$alias topic is 405", async () => {
  server = await startServer({ devices: [ACURITE] });
  expect((await server.post(topicOf(ACURITE), JSON.stringify("x"))).status).toBe(405);
  expect((await server.post("other-source/M/1/$alias", JSON.stringify("x"))).status).toBe(405);
});

test("a malformed topic is 400", async () => {
  server = await startServer({});
  expect((await server.get("a//c")).status).toBe(400);
  expect((await server.get(SOURCE + "/M/1 2")).status).toBe(400);
});

test("an empty alias body removes the alias", async () => {
  server = await startServer({ devices: [ACURITE] });
  const topic = topicOf(ACURITE) + "/$alias";
  await server.post(topic, JSON.stringify("Back fence"));
  expect((await server.post(topic, JSON.stringify(""))).status).toBe(204);
  expect((await server.get(topic)).status).toBe(404);
});

test("+ matches one segment and # matches the remainder", async () => {
  server = await startServer({ devices: [ACURITE, OREGON] });
  const one = await openStream(server.url, "?f=" + encodeURIComponent(SOURCE + "/+/396"));
  const all = await openStream(server.url, "?f=" + encodeURIComponent(SOURCE + "/#"));
  expect((await one.settle()).map(f => f.topic)).toEqual([topicOf(ACURITE)]);
  expect((await all.settle()).map(f => f.topic).sort())
    .toEqual([topicOf(ACURITE), topicOf(OREGON)].sort());
  one.close();
  all.close();
});

test("a filter matching nothing opens a stream that stays empty", async () => {
  server = await startServer({ devices: [ACURITE] });
  const s = await openStream(server.url, "?f=nobody/%2B/%2B");
  expect(s.status).toBe(200);
  server.emit(OREGON);
  expect(await s.settle()).toEqual([]);
  s.close();
});

test("an invalid filter is 400", async () => {
  server = await startServer({});
  const s = await openStream(server.url, "?f=" + encodeURIComponent("a/#/c"));
  expect(s.status).toBe(400);
  s.close();
});

test("an invalid filter's 400 still allows any origin", async () => {
  server = await startServer({});
  const s = await openStream(server.url, "?f=" + encodeURIComponent("a/#/c"));
  expect(s.status).toBe(400);
  expect(s.headers["access-control-allow-origin"]).toBe("*");
  s.close();
});

test("repeated f delivers from every filter and a topic matching both once", async () => {
  server = await startServer({ devices: [] });
  const s = await openStream(server.url,
    "?f=" + encodeURIComponent(SOURCE + "/Acurite-5n1/#") +
    "&f=" + encodeURIComponent(SOURCE + "/+/396") +
    "&f=" + encodeURIComponent(SOURCE + "/Oregon-THN132N/23"));
  server.emit(ACURITE);
  server.emit(OREGON);
  const topics = (await s.settle()).map(f => f.topic);
  expect(topics).toEqual([topicOf(ACURITE), topicOf(OREGON)]);
  s.close();
});

test("a subscriber receives retained messages before any live one", async () => {
  server = await startServer({ devices: [ACURITE] });
  const alias = topicOf(ACURITE) + "/$alias";
  await server.post(alias, JSON.stringify("Back fence"));
  const s = await openStream(server.url);
  server.emit(OREGON);
  const topics = (await s.settle()).map(f => f.topic);
  expect(topics.indexOf(topicOf(OREGON))).toBe(topics.length - 1);
  expect(topics.slice(0, -1).sort()).toEqual([alias, topicOf(ACURITE)].sort());
  s.close();
});

test("$alias round-trips through a # subscription", async () => {
  server = await startServer({ devices: [ACURITE] });
  const s = await openStream(server.url, "?f=%23");
  await s.settle();
  const alias = topicOf(ACURITE) + "/$alias";
  await server.post(alias, JSON.stringify("Back fence"));
  const frames = await s.settle();
  expect(frames[frames.length - 1]).toEqual({ topic: alias, payload: "Back fence" });
  s.close();
});

test("a device with no alias omits the topic rather than returning an empty string", async () => {
  server = await startServer({ devices: [ACURITE] });
  const s = await openStream(server.url);
  const topics = (await s.settle()).map(f => f.topic);
  expect(topics).not.toContain(topicOf(ACURITE) + "/$alias");
  s.close();
});

test("a device payload carries time, rssi and count", async () => {
  server = await startServer({ devices: [ACURITE] });
  const body = JSON.parse((await server.get(topicOf(ACURITE))).body);
  expect(typeof body.time).toBe("string");
  expect(Number.isFinite(Date.parse(body.time))).toBe(true);
  expect(typeof body.rssi).toBe("number");
  expect(body.count).toBe(1);

  server.emit(ACURITE);
  expect(JSON.parse((await server.get(topicOf(ACURITE))).body).count).toBe(2);
});
