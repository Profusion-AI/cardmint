export type StrictHints = {
  ocr_name?: string[];
  ocr_number_raw?: string;
  tokens?: string[]; // e.g., ["2023","EN","Regulation F"]
  symbol_candidates?: { set_name: string; set_code?: string; score?: number }[];
};

export type ImageInput = { label: string; mime: string; base64: string };

export function buildStrictMessages(
  images: ImageInput[],
  hints?: StrictHints,
  fewShots: boolean = true
) {
  const system = {
    role: "system" as const,
    content:
      "You identify Pokémon TCG cards using multiple images and OCR hints. Prioritize printed text over artwork, but make your best identification attempt. Output strict JSON: { \"card_title\": string, \"identifier\": ({\"number\": string (digits only), \"set_size\": string (digits only)} | {\"promo_code\": string (uppercase alphanumeric)}), \"set_name\": string, \"first_edition\": boolean }. Focus on card numbers and set symbols for accurate identification.",
  };

  const userBlocks: any[] = [];
  userBlocks.push({ type: "text", text: "Identify this Pokémon card and extract JSON per schema." });

  for (const img of images) {
    userBlocks.push({
      type: "text",
      text: `Image: ${img.label}`,
    });
    userBlocks.push({
      type: "image_url",
      image_url: { url: `data:${img.mime};base64,${img.base64}` },
    });
  }

  if (hints && (hints.ocr_name || hints.ocr_number_raw || hints.tokens || hints.symbol_candidates)) {
    userBlocks.push({ type: "text", text: "Hints (use to improve precision; do not invent):" });
    userBlocks.push({ type: "text", text: JSON.stringify(hints) });
  }

  const messages: any[] = [system];

  if (fewShots) {
    // Few-shot 1: Regular card with number/set_size
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "Example card with regular numbering format." },
      ],
    });
    messages.push({
      role: "assistant",
      content:
        '{"card_title":"Totodile","identifier":{"number":"81","set_size":"111"},"set_name":"Neo Genesis","first_edition":true}',
    });

    // Few-shot 2: Modern card with zero-padded number (strip padding)
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "Example modern card with padded numbers like 052/189." },
      ],
    });
    messages.push({
      role: "assistant",
      content:
        '{"card_title":"Toxapex","identifier":{"number":"52","set_size":"189"},"set_name":"Darkness Ablaze","first_edition":false}',
    });

    // Few-shot 3: Promo with alphanumeric code
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "Example promo card with alphanumeric identifier." },
      ],
    });
    messages.push({
      role: "assistant",
      content:
        '{"card_title":"Polteageist V","identifier":{"promo_code":"SWSH021"},"set_name":"SWSH Black Star Promos","first_edition":false}',
    });
  }

  messages.push({ role: "user", content: userBlocks });
  return messages;
}

