import { initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, GoogleAIBackend, type AI } from "firebase/ai";
import { getAuth, signInAnonymously, type Auth } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";

const env = import.meta.env;

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.appId);

let app: FirebaseApp | undefined;
let ai: AI | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;
let deviceAi: AI | undefined;

/** The app used for everything that may reach the cloud, with App Check. Created at its first use. */
export function getFirebaseApp(): FirebaseApp {
  return ensureApp();
}

function ensureApp(): FirebaseApp {
  if (app) return app;
  if (!isFirebaseConfigured) {
    throw new Error("Firebase is not configured. Copy .env.example to .env.local and fill it in.");
  }
  app = initializeApp(firebaseConfig);

  // App Check protects the Gemini API behind Firebase AI Logic.
  // In local development the debug provider is used; the token must be registered
  // in the Firebase console and is never committed.
  // `import.meta.env.DEV` is written out in full so the bundler removes this
  // whole block, token included, from production builds.
  if (import.meta.env.DEV && import.meta.env.VITE_APPCHECK_DEBUG === "true") {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY || "unset-site-key"),
    isTokenAutoRefreshEnabled: true,
  });
  return app;
}

/**
 * Firestore holds only the shared cache of compiled public trial rules. The
 * persistent local cache lets previously seen rules be read with no network.
 */
export function getDb(): Firestore {
  if (!db) {
    db = initializeFirestore(ensureApp(), {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  }
  return db;
}

/** Firebase AI Logic entry point (Gemini Developer API backend), for every call that may reach the cloud. */
export function getAi(): AI {
  if (!ai) ai = getAI(ensureApp(), { backend: new GoogleAIBackend() });
  return ai;
}

/**
 * Firebase AI Logic for strictly on-device calls (ONLY_ON_DEVICE), on a separate
 * app instance with no App Check and no sign-in. These calls need no network, so
 * reading a private record loads nothing and contacts no server, not even the
 * reCAPTCHA script that App Check uses. And if such a call ever tried to reach the
 * cloud, it would carry no App Check token and the service would refuse it.
 */
export function getDeviceAi(): AI {
  if (!deviceAi) {
    if (!isFirebaseConfigured) {
      throw new Error("Firebase is not configured. Copy .env.example to .env.local and fill it in.");
    }
    deviceAi = getAI(initializeApp(firebaseConfig, "on-device"), { backend: new GoogleAIBackend() });
  }
  return deviceAi;
}

/**
 * Anonymous sign-in: cloud requests carry a Firebase Auth credential, but the
 * person never creates an account and no identity is attached to them.
 */
export async function ensureSignedIn(): Promise<string> {
  if (!auth) auth = getAuth(ensureApp());
  if (auth.currentUser) return auth.currentUser.uid;
  const cred = await signInAnonymously(auth);
  return cred.user.uid;
}
