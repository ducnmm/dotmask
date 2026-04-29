/**
 * Unit tests for dotmask masker.ts
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeFake, maskText, unmaskText, isAiDomain, findSafeFlushLength, maskMessages, maskJsonPayload } from "../dist/proxy/masker.js";

// ── makeFake ──────────────────────────────────────────────────────────────────

describe("makeFake", () => {
  test("preserves prefix for sk-or-v1- token", () => {
    const real = "sk-or-v1-abc123XYZreallongtoken9999";
    const fake = makeFake(real);
    assert.ok(fake.startsWith("sk-or-v1-"), `expected sk-or-v1- prefix, got: ${fake}`);
  });

  test("preserves prefix for sk-ant token", () => {
    const real = "sk-ant-api03-verylongrealkey1234567890abcdef";
    const fake = makeFake(real);
    assert.ok(fake.startsWith("sk-ant-api"), `expected sk-ant-api prefix, got: ${fake}`);
  });

  test("preserves prefix for sk-proj- token", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const fake = makeFake(real);
    assert.ok(fake.startsWith("sk-proj-"), `expected sk-proj- prefix, got: ${fake}`);
  });

  test("preserves prefix for GitHub PAT", () => {
    const real = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const fake = makeFake(real);
    assert.ok(fake.startsWith("ghp_"), `expected ghp_ prefix, got: ${fake}`);
  });

  test("same length as original", () => {
    const real = "sk-or-v1-abc123XYZreallongtoken9999";
    const fake = makeFake(real);
    assert.equal(fake.length, real.length);
  });

  test("is deterministic — same input always gives same output", () => {
    const real = "sk-or-v1-abc123XYZreallongtoken9999";
    assert.equal(makeFake(real), makeFake(real));
    assert.equal(makeFake(real), makeFake(real));
  });

  test("different inputs give different outputs", () => {
    const a = makeFake("sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const b = makeFake("sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.notEqual(a, b);
  });

  test("fake != real", () => {
    const real = "sk-or-v1-abc123XYZreallongtoken9999";
    assert.notEqual(makeFake(real), real);
  });

  test("short values (< 8 chars) returned as-is", () => {
    assert.equal(makeFake("abc"), "abc");
    assert.equal(makeFake(""), "");
  });
});

// ── maskText ──────────────────────────────────────────────────────────────────

describe("maskText (no keychain — empty map)", () => {
  test("masks sk-or-v1- token in plain text", () => {
    const text = "my key is sk-or-v1-abcdefghijklmnopqrstuvwxyz12345";
    const { masked, count } = maskText(text, new Map());
    assert.equal(count, 1);
    assert.ok(!masked.includes("sk-or-v1-abcdefghijklmnopqrstuvwxyz12345"));
    assert.ok(masked.includes("sk-or-v1-"));
  });

  test("masks Anthropic token", () => {
    const text = "token=sk-ant-api03-longkeyhere1234567890abcdef";
    const { masked, count } = maskText(text, new Map());
    assert.ok(count >= 1, `expected at least 1 mask, got ${count}`);
    assert.ok(!masked.includes("sk-ant-api03-longkeyhere1234567890abcdef"));
    assert.ok(masked.includes("sk-ant-api"));
  });

  test("masks GitHub PAT", () => {
    const text = "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const { masked, count } = maskText(text, new Map());
    assert.ok(count >= 1, `expected at least 1 mask, got ${count}`);
    assert.ok(!masked.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345"));
  });

  test("count = 0 for text with no secrets", () => {
    const { count } = maskText("hello world, nothing secret here", new Map());
    assert.equal(count, 0);
  });

  test("masks env-var assignment with secret key name", () => {
    const text = "OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz12345";
    const { masked, count } = maskText(text, new Map());
    assert.ok(count >= 1);
    assert.ok(!masked.includes("abcdefghijklmnopqrstuvwxyz12345"));
  });

  test("does not mask short values", () => {
    const { masked, count } = maskText("SECRET=short", new Map());
    assert.equal(count, 0);
    assert.ok(masked.includes("short"));
  });

  test("replaces registered real values from map", () => {
    const real = "my-super-secret-value-1234567890";
    const fake = makeFake(real);
    const map = new Map([[real, fake]]);
    const { masked, count } = maskText(`use ${real} here`, map);
    assert.equal(count, 1);
    assert.ok(masked.includes(fake));
    assert.ok(!masked.includes(real));
  });
});

// ── unmaskText ────────────────────────────────────────────────────────────────

describe("unmaskText", () => {
  test("reverses what maskText did", () => {
    const real = "sk-or-v1-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const fakeToReal = new Map([[fake, real]]);

    const { unmasked, count } = unmaskText(`here is the key: ${fake} end`, fakeToReal);
    assert.equal(count, 1);
    assert.ok(unmasked.includes(real));
    assert.ok(!unmasked.includes(fake));
  });

  test("handles multiple tokens", () => {
    const r1 = "sk-or-v1-aaaabbbbccccddddeeeeffffgggg1234";
    const r2 = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const f1 = makeFake(r1);
    const f2 = makeFake(r2);
    const map = new Map([[f1, r1], [f2, r2]]);

    const { unmasked, count } = unmaskText(`key1=${f1} key2=${f2}`, map);
    assert.equal(count, 2);
    assert.ok(unmasked.includes(r1));
    assert.ok(unmasked.includes(r2));
  });

  test("no-op when map is empty", () => {
    const text = "no secrets here";
    const { unmasked, count } = unmaskText(text, new Map());
    assert.equal(count, 0);
    assert.equal(unmasked, text);
  });

  test("round-trip: mask then unmask = original", () => {
    const real = "sk-or-v1-abcdefghijklmnopqrstuvwxyz12345";
    const { masked } = maskText(`my key is ${real}`, new Map());
    const fake = makeFake(real);
    const { unmasked } = unmaskText(masked, new Map([[fake, real]]));
    assert.ok(unmasked.includes(real));
  });
});

// ── isAiDomain ────────────────────────────────────────────────────────────────

describe("isAiDomain", () => {
  test("matches api.anthropic.com",     () => assert.ok(isAiDomain("api.anthropic.com")));
  test("matches api.openai.com",        () => assert.ok(isAiDomain("api.openai.com")));
  test("matches openrouter.ai",         () => assert.ok(isAiDomain("openrouter.ai")));
  test("matches with :443 suffix",      () => assert.ok(isAiDomain("api.anthropic.com:443")));
  test("does NOT match github.com",     () => assert.ok(!isAiDomain("github.com")));
  test("does NOT match google.com",     () => assert.ok(!isAiDomain("google.com")));
  test("does NOT match npm registry",   () => assert.ok(!isAiDomain("registry.npmjs.org")));
});

// ── findSafeFlushLength (streaming split recovery) ────────────────────────────

describe("findSafeFlushLength", () => {
  const fakeKeys = [
    "sk-or-v1-abcdefghijklmnopqrstuvwxyz12345",
    "sk-ant-api03-verylongrealkey1234567890abcdef",
  ];

  test("flushes everything if no prefix match is found", () => {
    const text = "hello world! this is just a normal response chunk.";
    const len = findSafeFlushLength(text, fakeKeys);
    assert.equal(len, text.length, "should be totally safe to flush");
  });

  test("stops before a partial fake key matching at the end", () => {
    // "sk-or-v1-a" is an exact prefix of the first fakekey
    const partial = "sk-or-v1-abcde"; 
    const text = `some response text before the key ${partial}`;
    const len = findSafeFlushLength(text, fakeKeys);
    
    // safe length should be right before the split token
    assert.equal(text.substring(0, len), "some response text before the key ");
    assert.equal(text.substring(len), partial);
  });

  test("stops before a very short partial match at the very end", () => {
    // just "sk" which matches "sk-or-v1..." and "sk-ant..."
    const text = `just some text followed by sk`;
    const len = findSafeFlushLength(text, fakeKeys);
    
    // safe length should chop off 'sk'
    assert.equal(text.substring(0, len), "just some text followed by ");
  });

  test("passes through occurrences that do NOT match the prefix", () => {
    // 'sk-something-else' doesn't match the specific fakeKeys precisely beyond 'sk-'
    // Wait, 'sk-something' has 'sk-' as prefix which DOES match "sk-or-v1" up to 3 chars
    // But what if it's "sk-nomatch"? It will match "sk-" suffix but nothing else.
    // The findSafeFlushLength strictly finds if a suffix of the text matches a prefix of fakeKey.
    // "followed by sk-" -> "sk-" matches the first 3 chars. So it will hold back "sk-".
    const text = "followed by sk-";
    const len = findSafeFlushLength(text, fakeKeys);
    assert.equal(text.substring(len), "sk-");
  });

  test("if exact key is fully present in the buffer, it is flushed (unmask handles replacement)", () => {
    // When the full key is present, findSafeFlushLength returns text.length — the whole
    // buffer is safe to flush because unmaskText will do the replacement afterwards.
    const text = `full key here sk-or-v1-abcdefghijklmnopqrstuvwxyz12345`;
    const len = findSafeFlushLength(text, fakeKeys);
    assert.equal(len, text.length, "full fake key present → flush everything, unmask will handle it");
  });
  
  test("works with multiple fake keys without issue", () => {
    const multiKeys = [
      "sk-or-v1-abc",
      "sk-ant-api-xyz"
    ];
    const text1 = "response sk-or";
    assert.equal(findSafeFlushLength(text1, multiKeys), "response ".length);
    
    const text2 = "response sk-ant-a";
    assert.equal(findSafeFlushLength(text2, multiKeys), "response ".length);
  });
});

// ── New token types (AWS, Stripe, JWT, Sui) ───────────────────────────────────

describe("makeFake — new token types", () => {
  test("preserves AKIA prefix for AWS access key ID", () => {
    const real = "AKIAIOSFODNN7EXAMPLE";   // exactly 20 chars
    const fake = makeFake(real);
    assert.ok(fake.startsWith("AKIA"), `expected AKIA prefix, got: ${fake}`);
    assert.equal(fake.length, real.length);
    assert.notEqual(fake, real);
    assert.match(fake, /^AKIA[A-Z0-9]{16}$/);
  });

  test("preserves sk_live_ prefix for Stripe live key", () => {
    const real = "sk_live_" + "abcdefghijklmnopqrstuvwxyz1234";
    const fake = makeFake(real);
    assert.ok(fake.startsWith("sk_live_"), `expected sk_live_ prefix, got: ${fake}`);
    assert.equal(fake.length, real.length);
    assert.notEqual(fake, real);
    assert.match(fake, /^sk_live_[A-Za-z0-9]+$/);
  });

  test("preserves sk_test_ prefix for Stripe test key", () => {
    const real = "sk_test_" + "abcdefghijklmnopqrstuvwxyz";
    const fake = makeFake(real);
    assert.ok(fake.startsWith("sk_test_"), `expected sk_test_ prefix, got: ${fake}`);
    assert.equal(fake.length, real.length);
    assert.notEqual(fake, real);
    assert.match(fake, /^sk_test_[A-Za-z0-9]+$/);
  });

  test("preserves GitHub PAT charset", () => {
    const real = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const fake = makeFake(real);
    assert.ok(fake.startsWith("ghp_"), `expected ghp_ prefix, got: ${fake}`);
    assert.match(fake, /^ghp_[A-Za-z0-9+/]+$/);
  });

  test("JWT fake preserves eyJ prefix and three-part structure", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const fake = makeFake(jwt);
    assert.ok(fake.startsWith("eyJ"), `expected eyJ prefix, got: ${fake}`);
    const origParts = jwt.split(".");
    const fakeParts = fake.split(".");
    assert.equal(fakeParts.length, 3, "fake JWT must have exactly 3 parts");
    assert.equal(fakeParts[0].length, origParts[0].length, "header length must match");
    assert.equal(fakeParts[1].length, origParts[1].length, "payload length must match");
    assert.equal(fakeParts[2].length, origParts[2].length, "signature length must match");
    assert.notEqual(fake, jwt);
  });

  test("JWT makeFake is deterministic", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    assert.equal(makeFake(jwt), makeFake(jwt));
  });

  test("preserves suiprivkey prefix for Sui bech32 private key", () => {
    const real = "suiprivkey1qpxsm4wr7ywne4l5fqtflkkwevrgkq5m7vx3jzhxr5n09txjwwgh5zl93gc";
    const fake = makeFake(real);
    assert.ok(fake.startsWith("suiprivkey"), `expected suiprivkey prefix, got: ${fake}`);
    assert.equal(fake.length, real.length);
    assert.notEqual(fake, real);
    assert.match(fake, /^suiprivkey[1qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/);
  });
});

describe("maskText — new token types", () => {
  test("masks AWS Access Key ID (AKIA...)", () => {
    const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const { masked, count } = maskText(text, new Map());
    assert.ok(count >= 1, `expected >= 1 mask, got ${count}`);
    assert.ok(!masked.includes("AKIAIOSFODNN7EXAMPLE"), "real key must not appear");
    assert.ok(masked.includes("AKIA"), "AKIA prefix must be preserved");
  });

  test("masks Stripe live secret key", () => {
    const text = "STRIPE_SECRET_KEY=" + "sk_live_" + "abcdefghijklmnopqrstuvwxyz1234";
    const { masked, count } = maskText(text, new Map());
    assert.ok(count >= 1, `expected >= 1 mask, got ${count}`);
    assert.ok(!masked.includes("sk_live_" + "abcdefghijklmnopqrstuvwxyz1234"), "real key must not appear");
    assert.ok(masked.includes("sk_live_"), "sk_live_ prefix must be preserved");
  });

  test("masks Stripe test secret key", () => {
    const text = "STRIPE_SECRET_KEY=" + "sk_test_" + "abcdefghijklmnopqrstuvwxyz";
    const { masked, count } = maskText(text, new Map());
    assert.ok(count >= 1, `expected >= 1 mask, got ${count}`);
    assert.ok(!masked.includes("sk_test_" + "abcdefghijklmnopqrstuvwxyz"), "real key must not appear");
    assert.ok(masked.includes("sk_test_"), "sk_test_ prefix must be preserved");
  });

  test("masks JWT token in Authorization header", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const text = `Authorization: Bearer ${jwt}`;
    const { masked, count } = maskText(text, new Map());
    assert.ok(count >= 1, `expected >= 1 mask, got ${count}`);
    assert.ok(!masked.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"), "real signature must not appear");
    assert.ok(masked.includes("eyJ"), "eyJ prefix must be preserved in fake");
  });

  test("masks Sui bech32 private key", () => {
    const sui = "suiprivkey1qpxsm4wr7ywne4l5fqtflkkwevrgkq5m7vx3jzhxr5n09txjwwgh5zl93gc";
    const text = `SUI_PRIVATE_KEY=${sui}`;
    const { masked, count } = maskText(text, new Map());
    assert.ok(count >= 1, `expected >= 1 mask, got ${count}`);
    assert.ok(!masked.includes(sui), "real key must not appear");
    assert.ok(masked.includes("suiprivkey"), "suiprivkey prefix must be preserved");
  });

  test("round-trip: AWS key mask then unmask = original", () => {
    const real = "AKIAIOSFODNN7EXAMPLE";
    const { masked } = maskText(`key=${real}`, new Map());
    const fake = makeFake(real);
    const { unmasked } = unmaskText(masked, new Map([[fake, real]]));
    assert.ok(unmasked.includes(real), "real AWS key must be restored after unmask");
  });

  test("round-trip: JWT mask then unmask = original", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const { masked } = maskText(`token=${jwt}`, new Map());
    const fake = makeFake(jwt);
    const { unmasked } = unmaskText(masked, new Map([[fake, jwt]]));
    assert.ok(unmasked.includes(jwt), "real JWT must be restored after unmask");
  });
});

// ── maskMessages ─────────────────────────────────────────────────────────────

describe("maskMessages", () => {
  test("masks string content", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const r2f = new Map([[real, fake]]);
    const msgs = [{ role: "user", content: `key is ${real}` }];
    const total = maskMessages(msgs, r2f);
    assert.equal(total, 1);
    assert.ok(msgs[0].content.includes(fake));
    assert.ok(!msgs[0].content.includes(real));
  });

  test("masks array content — text block", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const r2f = new Map([[real, fake]]);
    const msgs = [{ role: "user", content: [{ type: "text", text: `key: ${real}` }] }];
    const total = maskMessages(msgs, r2f);
    assert.equal(total, 1);
    assert.ok(msgs[0].content[0].text.includes(fake));
  });

  test("array content — non-text blocks skipped", () => {
    const r2f = new Map();
    const msgs = [{ role: "user", content: [{ type: "image", source: { data: "base64..." } }] }];
    const total = maskMessages(msgs, r2f);
    assert.equal(total, 0);
  });

  test("null and non-object messages skipped", () => {
    const r2f = new Map();
    const total = maskMessages([null, 42, "string", undefined], r2f);
    assert.equal(total, 0);
  });

  test("multiple messages multiple secrets", () => {
    const r1 = "sk-proj-aaaabbbbccccddddeeeeffffgggg1234";
    const r2 = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const f1 = makeFake(r1);
    const f2 = makeFake(r2);
    const r2f = new Map([[r1, f1], [r2, f2]]);
    const msgs = [
      { role: "user", content: `key1=${r1}` },
      { role: "user", content: `key2=${r2}` },
    ];
    const total = maskMessages(msgs, r2f);
    assert.equal(total, 2);
  });

  test("empty array → 0", () => {
    assert.equal(maskMessages([], new Map()), 0);
  });

  test("message without content — no crash", () => {
    const total = maskMessages([{ role: "system" }], new Map());
    assert.equal(total, 0);
  });

  test("mutates in-place", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const r2f = new Map([[real, fake]]);
    const msg = { role: "user", content: `secret: ${real}` };
    const msgs = [msg];
    maskMessages(msgs, r2f);
    assert.ok(msg.content.includes(fake), "original object should be mutated");
  });

  test("masks tool_result string content", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const r2f = new Map([[real, fake]]);
    const msgs = [{
      role: "assistant",
      content: [{ type: "tool_result", content: `tool says ${real}` }],
    }];

    const total = maskMessages(msgs, r2f);
    assert.equal(total, 1);
    assert.ok(msgs[0].content[0].content.includes(fake));
    assert.ok(!msgs[0].content[0].content.includes(real));
  });

  test("masks nested tool_result text blocks", () => {
    const real = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const fake = makeFake(real);
    const r2f = new Map([[real, fake]]);
    const msgs = [{
      role: "assistant",
      content: [{ type: "tool_result", content: [{ type: "text", text: `nested ${real}` }] }],
    }];

    const total = maskMessages(msgs, r2f);
    assert.equal(total, 1);
    assert.ok(msgs[0].content[0].content[0].text.includes(fake));
    assert.ok(!msgs[0].content[0].content[0].text.includes(real));
  });
});

describe("maskJsonPayload", () => {
  test("masks Anthropic-style messages and system fields", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const map = new Map([[real, fake]]);
    const payload = {
      system: [{ type: "text", text: `system ${real}` }],
      messages: [{ role: "user", content: [{ type: "text", text: `msg ${real}` }] }],
    };

    const count = maskJsonPayload(payload, map);

    assert.equal(count, 2);
    assert.ok(payload.system[0].text.includes(fake));
    assert.ok(payload.messages[0].content[0].text.includes(fake));
  });

  test("masks Gemini-style contents and system_instruction parts", () => {
    const real = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde12345";
    const fake = makeFake(real);
    const map = new Map([[real, fake]]);
    const payload = {
      system_instruction: { parts: [{ text: `sys ${real}` }] },
      contents: [{ parts: [{ text: `user ${real}` }] }],
    };

    const count = maskJsonPayload(payload, map);

    assert.equal(count, 2);
    assert.ok(payload.system_instruction.parts[0].text.includes(fake));
    assert.ok(payload.contents[0].parts[0].text.includes(fake));
  });

  test("masks OpenAI responses-style input text", () => {
    const real = "sk-or-v1-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const map = new Map([[real, fake]]);
    const payload = {
      instructions: `follow ${real}`,
      input: [{ role: "user", content: [{ type: "input_text", text: `ask ${real}` }] }],
    };

    const count = maskJsonPayload(payload, map);

    assert.equal(count, 2);
    assert.ok(payload.instructions.includes(fake));
    assert.ok(payload.input[0].content[0].text.includes(fake));
  });

  test("masks string input fields", () => {
    const real = "sk-ant-api03-verylongrealkey1234567890abcdef";
    const fake = makeFake(real);
    const map = new Map([[real, fake]]);
    const payload = { input: `prompt ${real}` };

    const count = maskJsonPayload(payload, map);

    assert.equal(count, 1);
    assert.ok(payload.input.includes(fake));
  });

  test("ignores unrelated structures", () => {
    const payload = { foo: "bar", nested: [{ nope: 1 }] };
    assert.equal(maskJsonPayload(payload, new Map()), 0);
  });
});

// ── maskText — additional edge cases ─────────────────────────────────────────

describe("maskText — edge cases", () => {
  test("same token appearing twice in text", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const r2f = new Map([[real, fake]]);
    const text = `first=${real} second=${real}`;
    const { masked, count } = maskText(text, r2f);
    assert.equal(count, 1);
    assert.ok(!masked.includes(real));
    const occurrences = masked.split(fake).length - 1;
    assert.equal(occurrences, 2, "fake should appear twice");
  });

  test("already-fake value not double-masked", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const r2f = new Map([[real, fake]]);
    const { masked } = maskText(`val=${fake}`, r2f);
    assert.ok(masked.includes(fake), "fake should pass through");
  });

  test("env-var double-quoted value masked", () => {
    const r2f = new Map();
    const text = 'MY_SECRET="sk-proj-abcdefghijklmnopqrstuvwxyz12345"';
    const { masked, count } = maskText(text, r2f);
    assert.ok(count >= 1);
    assert.ok(!masked.includes("abcdefghijklmnopqrstuvwxyz12345"));
  });

  test("env-var single-quoted value masked", () => {
    const r2f = new Map();
    const text = "MY_SECRET='sk-proj-abcdefghijklmnopqrstuvwxyz12345'";
    const { masked, count } = maskText(text, r2f);
    assert.ok(count >= 1);
    assert.ok(!masked.includes("abcdefghijklmnopqrstuvwxyz12345"));
  });

  test("value containing ... is excluded from high-entropy detection", () => {
    const r2f = new Map();
    // Use a non-secret key name so only isHighEntropySecret path is tested
    const text = "MYVAR=abcdef...ghijklmnopqrstuvwx";
    const { count } = maskText(text, r2f);
    assert.equal(count, 0, "values with ... should not be masked via high-entropy path");
  });

  test("EVM private key (0x + 64 hex)", () => {
    const r2f = new Map();
    const text = "0x" + "a".repeat(64);
    const { masked, count } = maskText(text, r2f);
    assert.ok(count >= 1);
    assert.ok(!masked.includes("0x" + "a".repeat(64)));
    assert.ok(masked.startsWith("0x"));
  });

  test("Ethereum address (0x + 40 hex) is not masked", () => {
    const r2f = new Map();
    const text = "0x" + "a".repeat(40);
    const { masked, count } = maskText(text, r2f);
    assert.equal(count, 0);
    assert.equal(masked, text);
  });

  test("DB URL (postgres://user:secret@host)", () => {
    const r2f = new Map();
    const text = "postgres://admin:s3cretP4ssw0rd@db.example.com:5432/mydb";
    const { masked, count } = maskText(text, r2f);
    assert.ok(count >= 1);
    assert.ok(!masked.includes("s3cretP4ssw0rd"));
  });

  test("Slack bot token (xoxb-)", () => {
    const r2f = new Map();
    const token = `xoxb-${"A".repeat(24)}`;
    const text = `SLACK_TOKEN=${token}`;
    const { masked, count } = maskText(text, r2f);
    assert.ok(count >= 1);
    assert.ok(!masked.includes(token));
  });
});

// ── unmaskText — additional edge cases ───────────────────────────────────────

describe("unmaskText — edge cases", () => {
  test("longest fake key matched first (substring safety)", () => {
    const shortReal = "sk-proj-shortshortshortshort1234";
    const longReal = "sk-proj-shortshortshortshort1234-extended";
    const shortFake = makeFake(shortReal);
    const longFake = makeFake(longReal);
    const map = new Map([[shortFake, shortReal], [longFake, longReal]]);
    const { unmasked } = unmaskText(`val=${longFake}`, map);
    assert.ok(unmasked.includes(longReal));
  });

  test("fake key at start of string", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const { unmasked, count } = unmaskText(`${fake} trailing`, new Map([[fake, real]]));
    assert.equal(count, 1);
    assert.ok(unmasked.startsWith(real));
  });

  test("fake key at end of string", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const { unmasked, count } = unmaskText(`leading ${fake}`, new Map([[fake, real]]));
    assert.equal(count, 1);
    assert.ok(unmasked.endsWith(real));
  });

  test("fake key appearing multiple times — count is 1 (one key type)", () => {
    const real = "sk-proj-abcdefghijklmnopqrstuvwxyz12345";
    const fake = makeFake(real);
    const { unmasked, count } = unmaskText(`${fake} and ${fake}`, new Map([[fake, real]]));
    assert.equal(count, 1, "count tracks distinct key types, not occurrences");
    const occurrences = unmasked.split(real).length - 1;
    assert.equal(occurrences, 2);
  });
});

// ── findSafeFlushLength — additional edge cases ──────────────────────────────

describe("findSafeFlushLength — edge cases", () => {
  test("key in the middle (not at end) — flush all", () => {
    const fakeKeys = ["sk-or-v1-abcdefghijklmnopqrstuvwxyz12345"];
    const text = `prefix ${fakeKeys[0]} suffix`;
    const len = findSafeFlushLength(text, fakeKeys);
    assert.equal(len, text.length);
  });

  test("empty fakeKeys — flush all", () => {
    const text = "anything at all sk-or-v1-abc";
    const len = findSafeFlushLength(text, []);
    assert.equal(len, text.length);
  });

  test("empty text — 0", () => {
    const len = findSafeFlushLength("", ["sk-or-v1-abc"]);
    assert.equal(len, 0);
  });

  test("text shorter than shortest partial match", () => {
    const fakeKeys = ["sk-or-v1-abcdefghijklmnopqrstuvwxyz12345"];
    const text = "s";
    const len = findSafeFlushLength(text, fakeKeys);
    assert.equal(len, 0, "'s' matches first char of fake key — hold back");
  });
});
