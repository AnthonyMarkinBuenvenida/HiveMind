// Fallback catalog for server/registry.mjs: what the discovery rules produced from the real
// OpenRouter and Gemini catalogs on 2026-10-04. Used only when a live catalog can't be fetched
// (and in tests, with MODEL_REGISTRY_LIVE=false). Regenerate rather than edit by hand.
export const SNAPSHOT = [
  {
    "id": "gemini-3.1-flash-lite",
    "provider": "gemini",
    "label": "Gemini 3.1 Flash Lite",
    "vendor": "Google",
    "contextWindow": 1048576,
    "maxOutput": 65536,
    "reasoning": "toggle",
    "efforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ],
    "vision": true,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": null
  },
  {
    "id": "gemini-3.5-flash",
    "provider": "gemini",
    "label": "Gemini 3.5 Flash",
    "vendor": "Google",
    "contextWindow": 1048576,
    "maxOutput": 65536,
    "reasoning": "toggle",
    "efforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ],
    "vision": true,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 32.6,
      "coding": 70.1
    }
  },
  {
    "id": "gemini-3.5-flash-lite",
    "provider": "gemini",
    "label": "Gemini 3.5 Flash Lite",
    "vendor": "Google",
    "contextWindow": 1048576,
    "maxOutput": 65536,
    "reasoning": "toggle",
    "efforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ],
    "vision": true,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 22.2,
      "coding": 49.3
    }
  },
  {
    "id": "gemini-3.6-flash",
    "provider": "gemini",
    "label": "Gemini 3.6 Flash",
    "vendor": "Google",
    "contextWindow": 1048576,
    "maxOutput": 65536,
    "reasoning": "toggle",
    "efforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ],
    "vision": true,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 34,
      "coding": 69.2
    }
  },
  {
    "id": "gemini-3.7-flash",
    "provider": "gemini",
    "label": "Gemini 3.7 Flash",
    "vendor": "Google",
    "contextWindow": 1048576,
    "maxOutput": 65536,
    "reasoning": "always",
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "vision": true,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 39.1,
      "coding": 76.1
    }
  },
  {
    "id": "gemini-3.8-flash",
    "provider": "gemini",
    "label": "Gemini 3.8 Flash",
    "vendor": "Google",
    "contextWindow": 1048576,
    "maxOutput": 65536,
    "reasoning": "always",
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "vision": true,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 40.9,
      "coding": 76.3
    }
  },
  {
    "id": "qwen/qwen3.8-27b:free",
    "provider": "openrouter",
    "label": "Qwen3.8 27B",
    "vendor": "Qwen",
    "contextWindow": 262144,
    "maxOutput": 235929,
    "reasoning": "toggle",
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "vision": true,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 33.7,
      "coding": 68.1
    }
  },
  {
    "id": "nvidia/nemotron-3.5-lightning:free",
    "provider": "openrouter",
    "label": "Nemotron 3.5 Lightning",
    "vendor": "NVIDIA",
    "contextWindow": 1000000,
    "maxOutput": 65536,
    "reasoning": "toggle",
    "efforts": [],
    "vision": false,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 12.9,
      "coding": 26.8
    }
  },
  {
    "id": "cohere/north-mini-code:free",
    "provider": "openrouter",
    "label": "North Mini Code",
    "vendor": "Cohere",
    "contextWindow": 256000,
    "maxOutput": 64000,
    "reasoning": "always",
    "efforts": [],
    "vision": false,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 9.9,
      "coding": 36.5
    }
  },
  {
    "id": "nvidia/nemotron-3-ultra-550b-a55b:free",
    "provider": "openrouter",
    "label": "Nemotron 3 Ultra",
    "vendor": "NVIDIA",
    "contextWindow": 1000000,
    "maxOutput": 65536,
    "reasoning": "toggle",
    "efforts": [
      "medium",
      "high"
    ],
    "vision": false,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 22.9,
      "coding": 49.3
    }
  },
  {
    "id": "google/gemma-4-31b-it:free",
    "provider": "openrouter",
    "label": "Gemma 4 31B",
    "vendor": "Google",
    "contextWindow": 262144,
    "maxOutput": 32768,
    "reasoning": "toggle",
    "efforts": [],
    "vision": true,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 14.7,
      "coding": 43.4
    }
  },
  {
    "id": "nvidia/nemotron-3-super-120b-a12b:free",
    "provider": "openrouter",
    "label": "Nemotron 3 Super",
    "vendor": "NVIDIA",
    "contextWindow": 262144,
    "maxOutput": 235929,
    "reasoning": "toggle",
    "efforts": [
      "low",
      "medium"
    ],
    "vision": false,
    "tools": true,
    "free": true,
    "price": {
      "input": 0,
      "output": 0
    },
    "quality": {
      "intelligence": 12.8,
      "coding": 37.7
    }
  }
];
