import { pgTable, integer, varchar, text, timestamp, jsonb, uuid, unique, primaryKey } from 'drizzle-orm/pg-core';

// Bảng users: Bản sao định tuyến giao diện, mỏ neo chính
export const users = pgTable('users', {
  moodleUserId: integer('moodle_user_id').primaryKey(),
  role: varchar('role', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }),
});

// Bảng chat_sessions: Lịch sử đa hội thoại
export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: integer('user_id')
    .references(() => users.moodleUserId, { onDelete: 'cascade' })
    .notNull(),
  moodleCourseId: integer('moodle_course_id').notNull(),
  messages: jsonb('messages').default('[]').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Bảng personal_materials: Tài liệu cá nhân
export const personalMaterials = pgTable('personal_materials', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: integer('user_id')
    .references(() => users.moodleUserId, { onDelete: 'cascade' })
    .notNull(),
  moodleCourseId: integer('moodle_course_id').notNull(),
  title: text('title').notNull(),
  storageUrl: text('storage_url').notNull(),
});

// Bảng learning_artifacts: Thành quả học tập (Summary, Mindmap)
export const learningArtifacts = pgTable('learning_artifacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: integer('user_id')
    .references(() => users.moodleUserId, { onDelete: 'cascade' })
    .notNull(),
  moodleCourseId: integer('moodle_course_id').notNull(),
  artifactType: varchar('artifact_type', { length: 50 }).notNull(),
  contentData: jsonb('content_data').notNull(),
});

// Bảng fcm_tokens: Quản lý thiết bị nhận thông báo đẩy
export const fcmTokens = pgTable('fcm_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: integer('user_id')
    .references(() => users.moodleUserId, { onDelete: 'cascade' })
    .notNull(),
  token: text('token').notNull().unique(),
  deviceId: varchar('device_id', { length: 255 }).notNull(),
  deviceType: varchar('device_type', { length: 50 }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
}, table => ({
  userDeviceUnique: unique('fcm_tokens_user_device_unique').on(table.userId, table.deviceId),
}));

export const moodleCredentials = pgTable('moodle_credentials', {
  userId: integer('user_id')
    .references(() => users.moodleUserId, { onDelete: 'cascade' })
    .primaryKey(),
  encryptedToken: text('encrypted_token').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const notificationDeliveries = pgTable('notification_deliveries', {
  userId: integer('user_id')
    .references(() => users.moodleUserId, { onDelete: 'cascade' })
    .notNull(),
  eventId: integer('event_id').notNull(),
  eventType: varchar('event_type', { length: 30 }).notNull(),
  reminderMinutes: integer('reminder_minutes').notNull(),
  eventTimestamp: timestamp('event_timestamp', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
}, table => ({
  deliveryKey: primaryKey({ columns: [table.userId, table.eventId, table.eventType, table.reminderMinutes] }),
}));

export const moodleEvents = pgTable('moodle_events', {
  userId: integer('user_id')
    .references(() => users.moodleUserId, { onDelete: 'cascade' })
    .notNull(),
  eventId: integer('event_id').notNull(),
  eventType: varchar('event_type', { length: 30 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  timestart: integer('timestart').notNull(),
}, table => ({
  eventKey: primaryKey({ columns: [table.userId, table.eventId, table.eventType] }),
}));

export const pushQueue = pgTable('push_queue', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userId: integer('user_id')
    .references(() => users.moodleUserId, { onDelete: 'cascade' })
    .notNull(),
  eventId: integer('event_id').notNull(),
  eventType: varchar('event_type', { length: 30 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  reminderMinutes: integer('reminder_minutes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Bảng events: Quản lý sự kiện thông báo tập trung theo môn học (mỗi moodle_event_id là duy nhất)
export const events = pgTable('events', {
  id: uuid('id').defaultRandom().primaryKey(),
  moodleEventId: integer('moodle_event_id').unique(),
  eventType: varchar('event_type', { length: 50 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  deliverTime: timestamp('deliver_time', { withTimezone: true }).notNull(),
  sentReminders: integer('sent_reminders').array().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  moodleCourseId: integer('moodle_course_id'),
  eventDetails: text('event_details'),
});

// Bảng user_courses: Ánh xạ sinh viên - môn học để điều hướng thông báo
export const userCourses = pgTable('user_courses', {
  userId: integer('user_id')
    .references(() => users.moodleUserId, { onDelete: 'cascade' })
    .notNull(),
  moodleCourseId: integer('moodle_course_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, table => ({
  pk: primaryKey({ columns: [table.userId, table.moodleCourseId] }),
}));

// TypeScript types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;

export type PersonalMaterial = typeof personalMaterials.$inferSelect;
export type NewPersonalMaterial = typeof personalMaterials.$inferInsert;

export type LearningArtifact = typeof learningArtifacts.$inferSelect;
export type NewLearningArtifact = typeof learningArtifacts.$inferInsert;

export type FcmToken = typeof fcmTokens.$inferSelect;
export type NewFcmToken = typeof fcmTokens.$inferInsert;

export type MoodleCredential = typeof moodleCredentials.$inferSelect;
export type NewMoodleCredential = typeof moodleCredentials.$inferInsert;

export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert;

export type MoodleEvent = typeof moodleEvents.$inferSelect;
export type NewMoodleEvent = typeof moodleEvents.$inferInsert;

export type PushQueueItem = typeof pushQueue.$inferSelect;
export type NewPushQueueItem = typeof pushQueue.$inferInsert;

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export type UserCourse = typeof userCourses.$inferSelect;
export type NewUserCourse = typeof userCourses.$inferInsert;

// Bảng document_embeddings: Vector database pgvector cho tài liệu LMS
export const documentEmbeddings = pgTable('document_embeddings', {
  id: uuid('id').defaultRandom().primaryKey(),
  moodleCourseId: integer('moodle_course_id').notNull(),
  documentTitle: varchar('document_title', { length: 255 }).notNull(),
  pageNumber: integer('page_number'),
  chunkText: text('chunk_text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  moodleFileId: integer('moodle_file_id').notNull(),
});

export type DocumentEmbedding = typeof documentEmbeddings.$inferSelect;
export type NewDocumentEmbedding = typeof documentEmbeddings.$inferInsert;

// Bảng semantic_query_cache: Semantic Cache cho AI response theo môn học
export const semanticQueryCache = pgTable('semantic_query_cache', {
  id: uuid('id').defaultRandom().primaryKey(),
  courseId: text('course_id').notNull(),
  queryText: text('query_text').notNull(),
  aiResponse: text('ai_response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type SemanticQueryCache = typeof semanticQueryCache.$inferSelect;
export type NewSemanticQueryCache = typeof semanticQueryCache.$inferInsert;


