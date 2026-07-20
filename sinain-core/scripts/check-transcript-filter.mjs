import assert from "node:assert/strict";
import { shouldDropTranscript } from "../src/audio/transcription.ts";

for (const text of [
  "Thanks for watching!",
  "Спасибо за просмотр.",
  "[music]",
  "please subscribe please subscribe",
  "ご視聴ありがとうございましたご視聴ありがとうございました",
  "kuch kuch kuch kuch kuch kuch",
]) assert.equal(shouldDropTranscript(text).drop, true, `expected drop: ${text}`);

for (const text of [
  "Thank you for helping me fix the microphone.",
  "The presenter said thanks for watching before answering questions.",
  "Спасибо, что помогли мне настроить микрофон.",
  "Продолжение следует после обсуждения результатов.",
]) assert.equal(shouldDropTranscript(text).drop, false, `expected pass: ${text}`);

console.log("transcript filter checks passed");
