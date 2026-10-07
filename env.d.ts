declare namespace NodeJS {
  interface ProcessEnv {
    DATABASE_URL?: string;
    NEXT_PUBLIC_SUPABASE_URL?: string;
    NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    CLOUDINARY_CLOUD_NAME?: string;
    CLOUDINARY_API_KEY?: string;
    CLOUDINARY_API_SECRET?: string;
    CLOUDINARY_URL?: string;
    GROQ_API_KEY?: string;
    GROQ_API_KEYS?: string;
    GEMINI_API_KEY?: string;
    GOOGLE_API_KEY?: string;
    OPENAI_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    MOODLE_URL?: string;
    MOODLE_TOKEN?: string;
    MOODLE_TOKEN_ENCRYPTION_KEY?: string;
    NEXT_PUBLIC_FIREBASE_API_KEY?: string;
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?: string;
    NEXT_PUBLIC_FIREBASE_PROJECT_ID?: string;
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?: string;
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?: string;
    NEXT_PUBLIC_FIREBASE_APP_ID?: string;
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID?: string;
    NEXT_PUBLIC_FIREBASE_VAPID_KEY?: string;
    FIREBASE_PROJECT_ID?: string;
    FIREBASE_CLIENT_EMAIL?: string;
    FIREBASE_PRIVATE_KEY?: string;
    CRON_SECRET?: string;
  }
}
