export interface MoonshotImageContent {
  type: "image_url";
  image_url: { url: string };
}

export interface MoonshotTextContent {
  type: "text";
  text: string;
}

export type MoonshotContent = MoonshotImageContent | MoonshotTextContent;

export interface MoonshotMessage {
  role: "user" | "assistant" | "system";
  content: string | MoonshotContent[];
}

export interface MoonshotChoice {
  index: number;
  message: {
    role: string;
    content: string;
  };
  finish_reason: string;
}

export interface MoonshotUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface MoonshotChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: MoonshotChoice[];
  usage: MoonshotUsage;
}

export interface ImageLoadResult {
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
}
