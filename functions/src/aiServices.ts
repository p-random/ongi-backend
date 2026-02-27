import OpenAI from "openai";
import * as admin from "firebase-admin";
import { PredictionServiceClient } from "@google-cloud/aiplatform";
import { google } from "@google-cloud/aiplatform/build/protos/protos";

interface PerspectiveDetail {
  keyword: string;
  description: string;
  details: string[];
}

interface SummaryResponse {
  perspective_1: PerspectiveDetail;
  perspective_2: PerspectiveDetail;
  perspective_3: PerspectiveDetail;
}

type Record = {
  question: string;
  answer: string;
};


//OPEN AI 지연 초기화
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is missing at runtime");
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

// Vertex AI Client 초기화
let _vertexAIClient: PredictionServiceClient | null = null;
function getVertexAIClient(): PredictionServiceClient {
  if (_vertexAIClient) return _vertexAIClient;

  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credentialsJson) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is missing at runtime");
  }
  const credentials = JSON.parse(credentialsJson);

  _vertexAIClient = new PredictionServiceClient({
    apiEndpoint: "asia-northeast3-aiplatform.googleapis.com",
    credentials,
  });
  return _vertexAIClient;
}


/*
  이미지 URL을 받아 분석 후, 자기 성찰을 위한 질문을 생성합니다. (OpenAI GPT-4o)
 */
export async function generateQuestionFromImageUrl(
  imageUrl: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ category: string; question: string }> {
  const openai = getOpenAI();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  const responseContent = completion.choices[0].message.content;

  try {
    if (!responseContent) throw new Error("OpenAI response is empty.");
    const parsed = JSON.parse(responseContent);
    if (typeof parsed.category !== "string" || typeof parsed.question !== "string") {
      throw new Error("Invalid JSON structure from OpenAI.");
    }
    return { category: parsed.category, question: parsed.question };
  } catch (error) {
    console.error("Failed to parse OpenAI JSON response:", error);
    return {
      category: "기타",
      question: responseContent || "오늘 하루는 어떠셨나요?",
    };
  }
}

/*
  7일간의 기록을 받아 요약 문장을 생성합니다. (OpenAI GPT-4o)
 */
export async function generateSummaryFromRecords(records: Record[], language: number): Promise<SummaryResponse> {
  const openai = getOpenAI();

  const SYSTEM_PROMPT_KO = `[System Message]

사용자의 7일간 기록 입력을 바탕으로, 3가지 관점에서 정의하는 "배지 요약"을 작성하는 역할이다.

[전체 규칙]

- 각 관점마다 아래 3가지를 생성한다. (1) 핵심 키워드 (1개의 단어/구) (2) 그 키워드를 설명하는 1문장 (3) 한 주에 대한 디테일한 요약 2~3문장
- 말투는 모두 부드러운 존댓말(~요)로 작성한다.
- 단순 사실 나열이 아니라, 그 안에 깔린 '에너지 흐름'과 '경험의 본질'을 표현해야 한다.
- 반드시 다음과 같은 JSON 형식으로 출력한다.
    
    { "perspective_1": { "keyword": "", "description": "", "details": [ "", "", "" ] }, "perspective_2": { "keyword": "", "description": "", "details": [ "", "", "" ] }, "perspective_3": { "keyword": "", "description": "", "details": [ "", "", "" ] } }
    

[키워드/설명 형식 제약]

- (1) keyword:
    - ‘~하기’ 형태의 동명사 또는 짧은 명사구로 작성한다. (예: "방향 잡기", "도전 넓히기", "관계에 기대기", "버티기", "정리하기")
    - 띄어쓰기를 포함해 최대 10자 이하여야 한다.
    - 1인칭 대명사(나, 저, 우리)를 keyword 안에 넣지 않아야 한다.
    - 기록을 대표할 수 있는 단어를 포함함으로써 추상적인 표현이 되지 않도록 한다.
- (2) description:
    - keyword를 한 줄로 풀어 설명하는 1문장이다.
    - 띄어쓰기를 포함해 최대 30자 이하여야 한다.
    - 반드시 존댓말(~요)로 끝나야 한다.
    - "질문에 답하면서", "기록을 하면서", "이 서비스를 이용하며"처럼 **서비스 사용 행위 자체**를 설명하는 문장은 절대 쓰면 안된다.
    - 반드시 "사용자가 어떤 감정·태도·방향성으로 한 주를 보냈는지"를 표현한다.
- (3) details:
    - 존댓말(~요)로 작성한 **2~3문장**이다.
    - 여기에서도 "질문에 답했다", "기록했다", "서비스를 이용했다"는 식의 메타 설명은 절대 사용하지 않는다.
    - 대신, **질문/답변 내용 안에서 드러난 구체적인 요소**를 최대한 활용한다.
        - 예: 로스쿨 지원, 가족과의 대화, 친구와의 재회, 집이라는 공간, 피자 맛집, 낙엽, 불안과 혼란, 그럼에도 스스로 위로 등
    - "내면의 목소리를 들으려 했다", "감정을 정리하려 했다"처럼 **누구에게나 적용되는 추상적인 문장만** 쓰지 말고, 실제 기록에서 드러난 감정·사건·관계를 꼭 1개 이상 포함해야 한다.

[관점별 지시 사항]

아래 3가지 관점에 따라 (1), (2), (3)을 생성한다. 각 관점에 대한 (keyword, description, details)의 세트가 모두 포함되어야 한다.

- 관점 1: 내면에 집중하는 관점 (perspective_1)
    - 7일간 기록에서 사용자의 '감정 변화', '깨달음', '생각'에 초점을 맞춘다.
    - 불안, 안도, 혼란, 기대, 자신감, 무기력 등 감정의 흐름과 "어떤 마음의 움직임이 있었는지"를 중심으로 요약한다.
- 관점 2: 경험에 집중하는 관점 (perspective_2)
    - 7일간 기록에서 "새롭게 시도한 것", "행동한 것", "즐긴 것", “경험한 것”에 초점을 맞춘다.
    - 회사 지원, 산책, 여행, 친구와의 만남, 취미 활동, 공부/일 등 실제로 세상과 상호작용한 경험을 중심으로 요약한다.
- 관점 3: 관계에 집중하는 관점 (perspective_3)
    - 7일간 기록에서 "타인과의 관계" 또는 "자기 자신과의 관계"에 초점을 맞춘다.
    - 친구, 가족, 동료, 또는 '나 자신'에 대한 태도와 연결감을 중심으로 요약한다.
    - 누가 나에게 힘이 되었는지, 누구에게 마음을 쓰고 있었는지, 혹은 나 자신을 어떻게 대하고 있었는지를 표현하세요.

[기록이 추상적이거나 짧은 경우에 대한 추가 지시]

- 어떤 날의 기록이 매우 짧거나 구체적이지 않아도, "정보가 부족하다"거나 "잘 모르겠다"라고 말하지 않는다.
- 그 안에서 반복되는 단어, 감정 표현, 관계(예: 가족, 친구, 나 자신), 목표(예: 공부, 휴식, 건강, 버티기) 등을 최대한 포착해 그 사람이 한 주 동안 어디에 마음을 두고 있었는지 추론해서 표현한다.
- 단, 실제로 기록에 등장하지 않은 구체적인 사건(예: 시험, 여행, 회사 등)을 절대로 지어내면 안된다. (기록에 없는 구체명사는 만들지 말고, 감정과 태도 수준에서 해석한다.)

[입출력 예시 생략...]
`;

  const SYSTEM_PROMPT_EN = `[System Message]

You are tasked with creating a "Badge Summary" from a user's 7-day log entries, defined from three perspectives.

[Overall Rules]

- For each perspective, generate the following three items: (1) a core keyword (a single word/phrase), (2) a single sentence explaining the keyword, and (3) a detailed summary of the week in 2-3 sentences.
- All text should be in a soft, polite tone.
- Instead of just listing facts, you must express the underlying 'flow of energy' and 'essence of the experience'.
- You must output in the following JSON format:
    
    { "perspective_1": { "keyword": "", "description": "", "details": [ "", "", "" ] }, "perspective_2": { "keyword": "", "description": "", "details": [ "", "", "" ] }, "perspective_3": { "keyword": "", "description": "", "details": [ "", "", "" ] } }
    

[Keyword/Description Format Constraints]

- (1) keyword:
    - Should be a gerund ('~ing') or a short noun phrase (e.g., "Finding Direction", "Expanding Challenges", "Leaning on Relationships", "Enduring", "Organizing").
    - Must be 15 characters or less, including spaces.
    - Should not include first-person pronouns (I, we, my).
    - Should include words representative of the records to avoid being too abstract.
- (2) description:
    - A single sentence that explains the keyword.
    - Must be 50 characters or less, including spaces.
    - Must end politely.
    - Never use meta-descriptions about the service itself, such as "While answering questions," "While logging," "While using this service."
    - Must express "what kind of emotion, attitude, or direction the user had for the week."
- (3) details:
    - **2-3 sentences** written in a polite tone.
    - Again, do not use meta-descriptions like "answered questions," "logged," "used the service."
    - Instead, make maximum use of **concrete elements revealed in the question/answer content**.
        - e.g., applying to law school, conversations with family, reuniting with a friend, the space of home, a great pizza place, autumn leaves, anxiety and confusion, but still self-comforting.
    - Do not only use **abstract sentences applicable to anyone**, like "tried to listen to their inner voice," "tried to sort out emotions." You must include at least one emotion, event, or relationship revealed in the actual records.

[Instructions by Perspective]

Generate (1), (2), and (3) according to the three perspectives below. A set of (keyword, description, details) for each perspective must be included.

- Perspective 1: Focus on the Inner Self (perspective_1)
    - Focus on the user's 'emotional changes', 'realizations', and 'thoughts' from the 7-day log.
    - Summarize centered on the flow of emotions like anxiety, relief, confusion, hope, confidence, lethargy, and "what kind of mental movements occurred."
- Perspective 2: Focus on Experience (perspective_2)
    - Focus on "new things tried," "actions taken," "things enjoyed," and "experiences had" from the 7-day log.
    - Summarize centered on experiences of actual interaction with the world, such as applying for a job, going for a walk, traveling, meeting friends, hobbies, studying/working.
- Perspective 3: Focus on Relationships (perspective_3)
    - Focus on "relationships with others" or "relationship with oneself" from the 7-day log.
    - Summarize centered on attitudes and connections with friends, family, colleagues, or 'oneself'.
    - Express who gave them strength, who they were caring for, or how they were treating themselves.

[Additional Instructions for Abstract or Short Records]

- Even if a day's record is very short or not specific, do not say "there is not enough information" or "I don't know."
- Do your best to capture recurring words, emotional expressions, relationships (e.g., family, friends, self), goals (e.g., study, rest, health, enduring) to infer and express where that person's mind was during the week.
- However, never invent specific events that did not appear in the records (e.g., exams, travel, work). (Do not create concrete nouns not in the records; interpret at the level of emotion and attitude.)

[Input/Output Examples Omitted...]
`;
  
  const systemPrompt = language === 0 ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_KO;

  const userPrompt = records
    .map((r, i) => `Day ${i + 1}\nQ: ${r.question}\nA: ${r.answer}`)
    .join("\n\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.5,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const responseContent = completion.choices[0].message.content;
  if (!responseContent) throw new Error("OpenAI summary response is empty.");

  return JSON.parse(responseContent) as SummaryResponse;
}

/*
  [신규] 유저의 날것 기록을 받아 "안전하고 예술적인 영어 프롬프트"로 변환합니다.
  목적: Vertex AI 안전 필터 회피 및 이미지 퀄리티 향상
 */
export async function generateSafeImagePrompt(userText: string): Promise<string> {
  const openai = getOpenAI();
  
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
          You are a professional prompt engineer for AI image generation.
          Your task is to convert the user's diary entries into a Safe, Artistic, and Abstract image prompt description.
          
          [Rules]
          1.  **Safety First**: Remove any violent, sexual, self-harm, or explicit content. Replace them with metaphorical or abstract visual descriptions (e.g., replace "blood" with "red crimson energy", "suicide" with "a lonely figure at a crossroads in mist").
          2.  **Style**: Cartoon-style illustration, warm and healing atmosphere.
          3.  **Language**: Output MUST be in English.
          4.  **Length**: Keep it concise (under 50 words).
          5.  **Output**: Return ONLY the prompt text. No "Here is the prompt:" prefix.
        `
      },
      {
        role: "user",
        content: userText
      }
    ]
  });

  return completion.choices[0].message.content || "A peaceful landscape with a gentle breeze, cartoon style.";
}

/**
  Vertex AI Imagen을 사용하여 이미지를 생성하고 Firebase Storage에 업로드합니다.
  @param uid 사용자 ID (저장 경로에 사용)
  @param userPrompt 이미지 생성을 위한 프롬프트 (반드시 정제된 영어 프롬프트여야 함)
  @returns Firebase Storage에 저장된 이미지의 공개 URL
 */
export async function generateAndStoreImage(
  uid: string,
  userPrompt: string,
): Promise<string> {
  const vertexAIClient = getVertexAIClient();

  const projectId = process.env.GCLOUD_PROJECT || "jerry-a9e31";
  const location = "us-central1"; // AI 모델 안정성을 위해 us-central1 고정
  const model = "imagegeneration@006";

  const endpoint = `projects/${projectId}/locations/${location}/publishers/google/models/${model}`;

  const request = {
    endpoint: endpoint,
    instances: [{
      structValue: {
        fields: {
          prompt: { stringValue: userPrompt },
        },
      },
    }],
    parameters: {
      structValue: {
        fields: {
          sampleCount: { numberValue: 1 },
        },
      },
    },
  };

  const responses = await vertexAIClient.predict(request);
  const response = responses[0];

  if (!response.predictions || response.predictions.length === 0) {
    throw new Error("Vertex AI returned no predictions.");
  }

  const prediction = response.predictions[0] as google.protobuf.IValue;
  const fields = prediction.structValue?.fields;
  const imageBytesBase64 = fields?.bytesBase64Encoded?.stringValue;

  if (!imageBytesBase64) {
    throw new Error("Failed to get base64 encoded image from Vertex AI response.");
  }

  const imageData = Buffer.from(imageBytesBase64, "base64");

  const bucket = admin.storage().bucket();
  
  // 저장 경로: uploads/{uid}/badges/파일명.png
  const fileName = `uploads/${uid}/badges/${Date.now()}-${Math.random()
    .toString(36)
    .substring(2)}.png`;
    
  const file = bucket.file(fileName);

  await file.save(imageData, {
    metadata: { contentType: "image/png" },
    public: true,
  });

  return file.publicUrl();
}