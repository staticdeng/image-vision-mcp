export interface VisionImageContent {
  type: "image_url";
  image_url: { url: string };
}

export interface VisionTextContent {
  type: "text";
  text: string;
}

export type VisionContent = VisionImageContent | VisionTextContent;

export interface VisionMessage {
  role: "user" | "assistant" | "system";
  content: string | VisionContent[];
}

export interface VisionChoice {
  index: number;
  message: {
    role: string;
    content: string;
  };
  finish_reason: string;
}

export interface VisionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface VisionChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: VisionChoice[];
  usage: VisionUsage;
}

export interface ImageLoadResult {
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
}
