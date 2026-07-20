import assert from "node:assert/strict";
import { redactChatPayload, redactOutbound } from "../src/privacy/cloud-egress.ts";

const secrets = [
  "4111 1111 1111 1111",
  `sk-${"a".repeat(24)}`,
  `csk-${"b".repeat(24)}`,
  "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
  "person@example.com",
  "AKIAIOSFODNN7EXAMPLE",
  "<private>wrapped</private>",
];
const input = secrets.join(" | ");
const assertScrubbed = (value) => {
  const output = JSON.stringify(value);
  for (const secret of secrets) assert.equal(output.includes(secret), false, `secret survived: ${secret}`);
};

assertScrubbed(redactOutbound(input));
assert.equal(redactOutbound(redactOutbound(input)), redactOutbound(input), "redaction must be idempotent");

const payload = {
  model: "example/model",
  messages: [
    { role: "system", content: `Protect ${secrets[1]} and ${secrets[4]}` },
    { role: "user", content: [
      { type: "text", text: input },
      { type: "input_audio", input_audio: { data: secrets[0], format: "wav" } },
    ] },
  ],
};
const scrubbed = redactChatPayload(payload);
assertScrubbed(scrubbed.messages.map((message) =>
  Array.isArray(message.content) ? message.content.filter((part) => part.type === "text") : message.content));
assert.equal(scrubbed.messages[1].content[1].input_audio.data, secrets[0], "audio bytes must be untouched");

console.log("egress redaction checks passed");
