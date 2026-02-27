import { Router, Request, Response } from "express";
import * as admin from "firebase-admin";
import {
  generateSummaryFromRecords,
  generateAndStoreImage,
  generateSafeImagePrompt, 
} from "../aiServices";

const router = Router();

interface PerspectiveDetail {
  keyword: string;
  description: string;
  details: string[];
}

interface BadgeDocument {
  uid: string;
  imageUrl: string;
  perspective_1: PerspectiveDetail;
  perspective_2: PerspectiveDetail;
  perspective_3: PerspectiveDetail;
  selected: number;
  checked: boolean;
  createdAt: admin.firestore.FieldValue;
}

type RecordData = {
  question: string;
  answer: string;
};

/*
  POST /badge
  사용자 기록(7개)을 기반으로 요약 및 이미지를 생성하고 Badge 컬렉션에 저장합니다.
  생성이 완료되면 프론트엔드 API를 통해 푸시 알림을 전송합니다.
 */
router.post("/", async (req: Request, res: Response) => {
  let uid: string;

  // ID Token 확인
  try {
    const idToken = req.headers.authorization?.split("Bearer ")[1];
    if (!idToken) {
      return res.status(401).json({ error: "Unauthorized: Missing ID token." });
    }
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    uid = decodedToken.uid;
  } catch (error) {
    console.error("Error verifying auth token:", error);
    return res.status(403).json({ error: "Forbidden: Invalid ID token." });
  }

  try {
    const db = admin.firestore();
    const uniqueDocId = `${uid}_${Date.now()}`; 
    const badgeDocRef = db.collection("Badge").doc(uniqueDocId);
    const accountDocRef = db.collection("Accounts").doc(uid);
    const accountDoc = await accountDocRef.get();
    const accountData = accountDoc.data();
    const fcmToken = accountData?.fcmToken;

    const { language } = req.body as { language: number };

    if (language === undefined) {
      return res.status(400).json({ error: "language is required" });
    }

    const recordsSnapshot = await db.collection("Record")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(7)
      .get();

    if (recordsSnapshot.empty || recordsSnapshot.size < 7) {
      return res.status(404).json({
        error: "Not enough records found. At least 7 records are required.",
      });
    }

    const records: RecordData[] = recordsSnapshot.docs.map((doc) => {
      const data = doc.data();
      return { question: data.question, answer: data.answer };
    });

    // [Step 4] AI 컨텐츠 생성 (안전한 이미지 생성을 위한 순차 처리)
    // 1. 유저 답변 합치기
    const answersText = records.map((r) => r.answer).join("\n");
    
    // 2. 날것의 텍스트를 GPT를 통해 '안전하고 예술적인 영어 프롬프트'로 변환
    console.log(`Generating safe prompt for user ${uid}...`);
    const safePrompt = await generateSafeImagePrompt(answersText);
    console.log("Safe Prompt Generated:", safePrompt);

    // 3. 요약 생성과 이미지 생성(안전한 프롬프트 사용)을 병렬로 진행
    const [summaryResult, imageResult] = await Promise.allSettled([
      generateSummaryFromRecords(records, language),
      generateAndStoreImage(uid, safePrompt),
    ]);

    // 에러 핸들링
    if (summaryResult.status === "rejected") {
      throw new Error(`Summary generation failed: ${summaryResult.reason}`);
    }
    if (imageResult.status === "rejected") {
      throw new Error(`Image generation failed: ${imageResult.reason}`);
    }

    const summary = summaryResult.value;
    const imageUrl = imageResult.value;

    // [Step 5] 데이터 저장 
    const newBadgeData: BadgeDocument = {
      uid: uid,
      imageUrl: imageUrl, 
      perspective_1: summary.perspective_1,
      perspective_2: summary.perspective_2,
      perspective_3: summary.perspective_3,
      selected: -1,
      checked: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // 'Badge' 컬렉션에 저장 (uid가 문서 ID)
    await badgeDocRef.set(newBadgeData);

    // [Step 6] FCM 푸시 알림 전송 (fcmToken이 존재할 경우)
    if (fcmToken) {
      try {
        console.log(`Sending push notification to user ${uid}...`);
        
        const pushResponse = await fetch("https://ongi-front.vercel.app/api/send-push", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            token: fcmToken,
            title: "배지가 도착했어요",
            body: "지금 바로 앱을 열어 알림을 확인해보세요",
            deepLink: "https://ongi-front.vercel.app/my",
          }),
        });

        if (!pushResponse.ok) {
          console.error(`Push API responded with status: ${pushResponse.status}`);
        } else {
          console.log("Push notification sent successfully.");
        }
      } catch (pushError) {
        console.error("Error sending push notification:", pushError);
        // 푸시 에러는 API 응답을 실패로 만들지 않음 (로그만 남김)
      }
    } else {
      console.log(`User ${uid} has no fcmToken. Skipping push notification.`);
    }

    // [Step 7] 결과 반환
    return res.json(newBadgeData);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error in /badge endpoint for UID ${uid}:`, err);
    return res.status(500).json({ error: "Failed to generate badge data", details: msg });
  }
});

export default router;