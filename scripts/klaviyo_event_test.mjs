// node scripts/klaviyo_event_test.mjs
// Requires Node 18+ (built-in fetch)

const API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
if (!API_KEY) {
  console.error("Error: Set KLAVIYO_PRIVATE_API_KEY environment variable");
  process.exit(1);
}

const url = "https://a.klaviyo.com/api/events/";
const payload = {
  data: {
    type: "event",
    attributes: {
      metric: { data: { type: "metric", attributes: { name: "Test Event" } } },
      profile: {
        data: {
          type: "profile",
          attributes: { email: "test@example.com", first_name: "Test" },
        },
      },
      properties: { source: "node", testRunId: `${Date.now()}` },
      time: new Date().toISOString(),
      value: 1,
      unique_id: `test-${Date.now()}`,
    },
  },
};

console.log("Sending event to Klaviyo...");
console.log("Payload:", JSON.stringify(payload, null, 2));

const res = await fetch(url, {
  method: "POST",
  headers: {
    accept: "application/vnd.api+json",
    "content-type": "application/vnd.api+json",
    revision: "2025-10-15",
    Authorization: `Klaviyo-API-Key ${API_KEY}`,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
console.log("\nResponse status:", res.status);
console.log("Response:", text ? JSON.parse(text) : "(empty body)");
