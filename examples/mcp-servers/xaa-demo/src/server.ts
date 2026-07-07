import express from "express";

const PORT = Number(process.env.PORT ?? 8080);
const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`xaa-demo listening on http://localhost:${PORT}`);
});
