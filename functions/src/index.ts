import "dotenv/config";
import * as functions from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import express from "express";
import imageRoutes from "./routes/imageRoutes";
import badgeRoutes from "./routes/badgeRoutes";

// Firebase Admin 초기화
if (!admin.apps.length) {
  admin.initializeApp();
}

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const GOOGLE_APPLICATION_CREDENTIALS_JSON = defineSecret("GOOGLE_APPLICATION_CREDENTIALS_JSON");

const app = express();
app.use(express.json());

// API 라우터 연결
app.use("/", imageRoutes);
app.use("/badge", badgeRoutes);

export const api = functions.onRequest(
  { 
    region: "asia-northeast3",
    memory: "512MiB",
    cors: true, 
    secrets: [OPENAI_API_KEY, GOOGLE_APPLICATION_CREDENTIALS_JSON], 
    minInstances: 1, 
  },
  app,
);