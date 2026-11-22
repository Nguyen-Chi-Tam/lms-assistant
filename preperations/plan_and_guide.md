# Kế hoạch & Hướng dẫn Kỹ thuật: Tăng cường Cá nhân hóa Học tập (`lms-assistant`)

Tài liệu này chốt toàn bộ kiến trúc dữ liệu, chính sách vòng đời lưu trữ, luồng gọi AI phía trình duyệt (**Puter.js**) tương thích **Vercel**, và hướng dẫn triển khai chi tiết cho **Dashboard phân tích điểm số** cùng **4 hoạt động tương tác (Playful Elements)**.

---

## 1. Kiến trúc Tổng thể & Tích hợp Puter.js trên Vercel

### 1.1. Phân chia vai trò Client – Server – Database
Để triệt tiêu hoàn toàn lỗi timeout trên Vercel Serverless Functions và giữ chi phí vận hành ở mức `$0`, hệ thống phân tách rõ nhiệm vụ:
* **Next.js API Routes (Server):** Xác thực người dùng, đồng bộ dữ liệu thô từ Moodle API, tính toán các chỉ số thống kê thuần toán học, truy xuất đoạn trích giáo trình (RAG) và ghi nhận kết quả tóm tắt vào Database.
* **Puter.js SDK (Client-side):** Thực thi 100% tác vụ sinh nội dung AI (lộ trình học tập, câu hỏi `quick_test`, dữ liệu 3 mini-games, nhận xét và giải pháp cải thiện) trực tiếp trên trình duyệt người dùng.
* **Supabase (PostgreSQL):** Lưu dữ liệu định danh (`users.moodle_user_id`), lịch sự kiện (`events`), `fcm_tokens` và bảng tổng hợp điểm + lịch sử nhận xét AI (`user_course_analytics`).
* **Firebase Cloud Firestore:** Lưu tài liệu giáo trình (`moodle_document_parents`), hội thoại (`chat_sessions`), tài liệu cá nhân (`personal_materials`) và bộ câu hỏi chờ sẵn duy nhất cho từng khóa (`learning_artifacts`).

### 1.2. Tích hợp Puter.js an toàn khi build & deploy lên Vercel
1. **Nạp SDK ở Layout phía Client:** Thêm thẻ `<Script>` vào component wrapper client để tránh lỗi `window is not defined` khi Vercel chạy `next build`:
   ```tsx
   // components/providers/PuterProvider.tsx
   "use client";
   import Script from "next/script";

   export function PuterProvider({ children }: { children: React.ReactNode }) {
     return (
       <>
         <Script src="https://js.puter.com/v2/" strategy="afterInteractive" />
         {children}
       </>
     );
   }
   ```
2. **Helper gọi Puter chuẩn hóa (hỗ trợ ép kiểu JSON & chống lỗi trình duyệt):**
   ```ts
   // lib/puter-client.ts
   declare global {
     interface Window {
       puter?: {
         ai: {
           chat: (
             prompt: string,
             options?: { model?: string; stream?: boolean }
           ) => Promise<any>;
         };
       };
     }
   }

   export async function askPuterJSON<T>(prompt: string, model = "gpt-4o-mini"): Promise<T> {
     if (typeof window === "undefined" || !window.puter) {
       throw new Error("Puter SDK chưa sẵn sàng trên trình duyệt.");
     }

     const fullPrompt = `${prompt}\n\nYÊU CẦU BẮT BUỘC: Chỉ trả về duy nhất một chuỗi JSON hợp lệ, không bọc trong markdown \`\`\`json, không giải thích thêm.`;
     const response = await window.puter.ai.chat(fullPrompt, { model });

     const rawText =
       typeof response === "string"
         ? response
         : response?.message?.content || response?.text || "";

     const cleaned = rawText.replace(/```json|```/g, "").trim();
     return JSON.parse(cleaned) as T;
   }
   ```
3. **Quy tắc chống chặn Popup trên HTTPS (`*.vercel.app`):**
   * Các tác vụ **chạy ngầm** (nạp sẵn bộ `quick_test` cho lần sau) phải bọc trong `try/catch` để thất bại âm thầm nếu người dùng chưa đăng nhập Puter.
   * Các tác vụ **tương tác chính** (bấm *Xem lộ trình*, *Chơi game*, *Nộp bài*) gắn thẳng vào sự kiện `onClick` để trình duyệt cho phép mở cửa sổ xác thực Puter khi cần.

---

## 2. Thiết kế Cơ sở Dữ liệu & Chính sách Tự động Dọn dẹp

### 2.1. Phân định nơi lưu trữ (Chiến lược Zero-Bloat)

| Loại dữ liệu | Nơi lưu trữ | Quy tắc lưu trữ |
| :--- | :--- | :--- |
| **Bộ câu hỏi 3 mini-games**<br>(`speed_matching`, `spot_the_bug`, `rapid_swipe`) | **Không lưu Database**<br>(Chỉ nằm trong `React State`) | Sinh ra lúc bấm *Bắt đầu*, chơi xong 30–45s và lấy xong nhận xét AI thì giải phóng khỏi RAM. |
| **Bộ 3 câu hỏi chờ sẵn**<br>(`quick_test`) | **Firestore**<br>(`learning_artifacts`) | Dùng ID cố định `qt_${userId}_${courseId}` với hàm `setDoc` để **ghi đè tại chỗ**. Mỗi khóa học mãi mãi chỉ tốn đúng **1 document**. |
| **Bảng điểm, xu hướng & Nhận xét AI** | **Supabase**<br>(`user_course_analytics`) | Gom vào 2 cột `JSONB` (`grade_summary` và `feedback_history`), giới hạn `.slice(-10)` nhận xét gần nhất cho cả `quick_test` lẫn 3 mini-games. |
| **Tài liệu giáo trình & Lịch sử chat** | **Firestore**<br>(`moodle_document_parents`, `chat_sessions`) | Chỉ giữ trong 1 học kỳ (150 ngày) nhờ cơ chế TTL tự xóa của Firestore. |
| **Tài liệu cá nhân tự tải lên** | **Firestore**<br>(`personal_materials`) | Giữ lại lâu dài để sinh viên tự quản lý. |

### 2.2. SQL Schema cho Supabase (`user_course_analytics`)
Chạy lệnh SQL sau trên Supabase SQL Editor:

```sql
CREATE TABLE user_course_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INT4 NOT NULL REFERENCES users(moodle_user_id) ON DELETE CASCADE,
  moodle_course_id INT4 NOT NULL,
  course_name VARCHAR NOT NULL,

  -- Lưu điểm hiện tại, điểm lần trước để tính delta, điểm mạnh/yếu và danh sách cột điểm
  grade_summary JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Lưu tối đa 10 nhận xét & lộ trình gần nhất (Rolling Window)
  feedback_history JSONB NOT NULL DEFAULT '[]'::jsonb,

  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, moodle_course_id)
);

CREATE INDEX idx_user_course_analytics_user ON user_course_analytics(user_id);
```

* **Mẫu dữ liệu cột `grade_summary`:**
  ```json
  {
    "average_pct": 78.5,
    "previous_average_pct": 72.0,
    "delta": 6.5,
    "trend": "improving",
    "strengths": ["Lab 1: REST API (90%)"],
    "weaknesses": ["Quiz 1: HTTP Lifecycle (55%)"],
    "items": [
      { "name": "Quiz 1", "pct": 55, "updated_at": "2026-10-01" },
      { "name": "Lab 1", "pct": 90, "updated_at": "2026-10-15" }
    ]
  }
  ```

* **Mẫu dữ liệu cột `feedback_history` (Hợp nhất nhận xét từ Dashboard, `quick_test` và 3 mini-games):**
  ```json
  [
    {
      "id": "fb_1731750000",
      "activity_type": "spot_the_bug",
      "score_label": "4/5 câu",
      "ai_feedback": "Bạn nhận diện tốt lỗi cú pháp nhưng hay bỏ sót lỗi bất đồng bộ async/await.",
      "improvement_plan": "Ôn lại Chương 3 về Promise và thử 1 lượt Thẻ quẹt 30s chủ đề Async JS.",
      "created_at": "2026-11-16T13:00:00Z"
    }
  ]
  ```

### 2.3. Chính sách Tự động Xóa Dữ liệu Cũ (Không cần Cron Job cho Firestore)
1. **Firestore TTL Policy (Tự động xóa sau 150 ngày):**
   * Khi ghi mới document vào `moodle_document_parents`, `chat_sessions` hoặc `learning_artifacts`, luôn đính kèm trường `expires_at` kiểu `Timestamp` (`Date.now() + 150 * 24 * 60 * 60 * 1000`).
   * Vào **Firebase Console $\rightarrow$ Firestore Database $\rightarrow$ Indexes $\rightarrow$ TTL**, kích hoạt chính sách TTL cho trường `expires_at` trên 3 collection trên. Firestore sẽ tự động dọn dẹp ngầm hoàn toàn miễn phí.
   * Collection `personal_materials` **không** gắn trường `expires_at`.
2. **Lazy Cleanup trên Supabase & Pinecone (Khi đồng bộ môn học):**
   * Trong API đồng bộ khóa học (`core_enrol_get_users_courses`), lấy danh sách `activeCourseIds` hiện tại của sinh viên.
   * Chạy lệnh xóa các dòng trong `user_course_analytics`, `events`, `semantic_query_cache` có `moodle_course_id` không nằm trong `activeCourseIds` (hoặc `updated_at < NOW() - INTERVAL '150 days'`), đồng thời gọi API xóa các vector có metadata `moodle_course_id` tương ứng trên Pinecone.
3. **Dọn dẹp `fcm_tokens` trên Supabase:**
   * Thiết lập `pg_cron` chạy ngày 1 hàng tháng: `DELETE FROM fcm_tokens WHERE last_used_at < NOW() - INTERVAL '60 days';`.

---

## 3. Hướng dẫn Chi tiết Từng Tính năng

### Tính năng 1: Dashboard Phân tích Tiến độ & Lộ trình Học tập

#### Bước 1.1: API đồng bộ điểm & tính toán chỉ số (`GET /api/dashboard/grades`)
1. Gọi Moodle API `core_enrol_get_users_courses` lấy các khóa đang học và `gradereport_user_get_grade_items` lấy chi tiết điểm từng thành phần.
2. Quy đổi điểm từng mục về thang $100\%$: $\text{pct} = (\text{graderaw} / \text{grademax}) \times 100$.
3. Tính toán các chỉ số:
   * **Trung bình từng khóa (`average_pct`)** và **Trung bình tất cả khóa học (GPA tổng)**.
   * **Điểm mạnh (`strengths`):** Các cột điểm có $\text{pct} \ge 80\%$.
   * **Điểm yếu (`weaknesses`):** Các cột điểm có $\text{pct} < 65\%$.
   * **Xu hướng (`trend` & `delta`):** So sánh `average_pct` mới với `average_pct` đang lưu trong `user_course_analytics.grade_summary`:
     * $\text{delta} \ge +5\% \Rightarrow$ `"improving"` (Đã cải thiện).
     * $\text{delta} \le -5\% \Rightarrow$ `"declining"` (Thụt lùi).
     * $-5\% < \text{delta} < +5\% \Rightarrow$ `"stable"` (Ổn định).
4. Chỉ thực hiện `UPSERT` vào `user_course_analytics` nếu điểm số có sự thay đổi so với lần đồng bộ trước.

#### Bước 1.2: Đề xuất Lộ trình Học tập bằng Puter.js
* Dashboard render tức thì biểu đồ điểm, GPA tổng, thẻ Điểm mạnh/Yếu và mũi tên tăng/giảm từ dữ liệu Supabase.
* Trên thẻ từng khóa học, khi người dùng bấm nút **"Tạo / Cập nhật lộ trình học"** (hoặc tự động kích hoạt khi điểm số vừa có biến động):
  1. Lấy danh sách tên tài liệu/chương của khóa học từ Firestore `moodle_document_parents`.
  2. Gọi `askPuterJSON()` gửi danh sách chương + `weaknesses` + `trend` để nhận về lộ trình 3 giai đoạn (Củng cố phần yếu $\rightarrow$ Luyện mini-game phản xạ $\rightarrow$ Ôn tập nâng cao).
  3. Lưu lộ trình này vào `feedback_history` của `user_course_analytics` (cắt giữ `.slice(-10)`).

---

### Tính năng 2a: 3 Câu hỏi Nhanh trước khi vào Khóa học (`quick_test`)

#### Bước 2a.1: Cơ chế kiểm soát kích hoạt chuẩn xác theo luồng tải Trang chủ
Đảm bảo quy tắc: **chỉ hỏi 3 câu sau mỗi lần reload lại web ở Trang chủ rồi vào khóa học; không hỏi lại khi F5 ngay trong trang khóa học hoặc thoát ra vào lại mà chưa reload Trang chủ**.

1. **Tại Trang chủ (`app/page.tsx`):**
   ```tsx
   useEffect(() => {
     // Cấp mã phiên tải trang chủ mới mỗi khi mở web hoặc F5 ở Trang chủ
     sessionStorage.setItem("lms_home_boot_id", crypto.randomUUID());
     sessionStorage.setItem("lms_quick_tested_courses", JSON.stringify([]));
   }, []);
   ```
2. **Tại Trang Chi tiết Khóa học (`app/courses/[courseId]/page.tsx`):**
   ```tsx
   useEffect(() => {
     const bootId = sessionStorage.getItem("lms_home_boot_id");
     if (!bootId) return; // Mở thẳng link khóa học từ bên ngoài, không đi qua Trang chủ

     const testedRaw = sessionStorage.getItem("lms_quick_tested_courses");
     const testedCourses: string[] = testedRaw ? JSON.parse(testedRaw) : [];

     if (!testedCourses.includes(String(courseId))) {
       setShowQuickTest(true);
       // Đánh dấu ngay lập tức để F5 tại trang khóa học không kích hoạt lại
       sessionStorage.setItem(
         "lms_quick_tested_courses",
         JSON.stringify([...testedCourses, String(courseId)])
       );
     }
   }, [courseId]);
   ```

#### Bước 2a.2: Luồng "Kho xoay vòng 1-Document + Nạp ngầm"
1. **Mở Modal (0ms độ trễ):** Truy vấn document cố định `learning_artifacts/qt_${userId}_${courseId}` trên Firestore.
   * Nếu đã có sẵn bộ 3 câu hỏi (`items.length === 3`), hiển thị ngay lập tức.
   * Nếu khóa học mới tinh chưa có bộ nào, lấy 2 đoạn trích từ `moodle_document_parents` và gọi `askPuterJSON()` tạo trực tiếp 3 câu hỏi trắc nghiệm.
2. **Nộp bài (`onClick`):**
   * Chấm điểm tại chỗ trên Client.
   * Gọi `askPuterJSON()` gửi 3 câu hỏi + lựa chọn của sinh viên để sinh `ai_feedback` (nhận xét ngắn gọn 2–3 câu) và `improvement_plan` (1 đề xuất cải thiện).
   * Gọi `POST /api/analytics/feedback` để nối bản tóm tắt kết quả này vào `user_course_analytics.feedback_history` trên Supabase.
3. **Nạp ngầm bộ câu hỏi mới cho lần sau:**
   * Ngay sau khi hoàn thành (chạy trong `try/catch` nền), gọi `askPuterJSON()` lấy 2 đoạn kiến thức ngẫu nhiên khác của môn học để sinh 3 câu hỏi mới và gọi `setDoc()` **ghi đè** lên chính document `learning_artifacts/qt_${userId}_${courseId}` (kèm `expires_at` mới = +150 ngày).

---

### Tính năng 2b: Không gian Học tập — 3 Mini-games & Nhận xét Tức thì

Xây dựng component khung `<StudyGameRunner courseId={courseId} mode={mode} />` dùng chung cho cả 3 trò chơi. Dữ liệu câu hỏi chỉ nằm trong `React State` suốt ván chơi.

#### 1. Nối cặp tốc độ (`speed_matching` — Kiểu Duolingo Match Madness)
* **Schema JSON từ Puter.js:**
  ```ts
  interface SpeedMatchingItem {
    id: string;
    left: string;  // Thuật ngữ / Hàm / Khái niệm (tối đa 5 từ)
    right: string; // Định nghĩa / Kết quả tương ứng (tối đa 8 từ)
  }
  ```
* **Luật chơi:** Sinh 10 cặp; hiển thị 5 cặp trên 2 cột (xáo trộn thứ tự) với đồng hồ đếm ngược **45 giây**. Chạm đúng 1 trái + 1 phải thì khóa xanh và thay bằng cặp kế tiếp từ hàng đợi; chạm sai rung đỏ và trừ 2 giây. Lưu các cặp nối nhầm vào `mistakes[]`.

#### 2. Bắt lỗi trong 1 chạm (`spot_the_bug` — Kiểu Mimo / Sửa câu Duolingo)
* **Schema JSON từ Puter.js:**
  ```ts
  interface SpotTheBugChallenge {
    id: string;
    instruction: string;       // Yêu cầu (VD: "Chạm vào phần gây lỗi logic")
    tokens: string[];          // Mảng các đoạn code hoặc cụm từ cấu thành câu
    bugIndex: number;          // Vị trí index trong mảng tokens chứa lỗi
    fixOptions: string[];      // 3 phương án sửa lỗi
    correctFixIndex: number;   // Index phương án sửa đúng
    explanation: string;
  }
  ```
* **Luật chơi:** Sinh 5 thử thách. Render `tokens` thành các khối bấm được. Người chơi chạm đúng `bugIndex`, sau đó chọn 1 trong 3 `fixOptions` hiện ra bên dưới. Chạm sai khối hoặc chọn sai cách sửa sẽ ghi nhận vào `mistakes[]`.

#### 3. Thẻ quẹt Đúng / Sai 30 giây (`rapid_swipe`)
* **Schema JSON từ Puter.js:**
  ```ts
  interface RapidSwipeCard {
    id: string;
    statement: string;   // Nhận định ngắn 1-2 câu từ giáo trình
    isTrue: boolean;
    correction: string;  // Giải thích ngắn nếu nhận định sai
  }
  ```
* **Luật chơi:** Sinh 12 thẻ. Hiển thị dạng chồng thẻ (Card Stack) với đồng hồ **30 giây**. Vuốt phải / mũi tên phải = **Đúng**; vuốt trái / mũi tên trái = **Sai**. Chấm điểm 0ms tại chỗ để giữ nhịp độ nhanh. Các thẻ quẹt sai đẩy vào `mistakes[]`.

#### 4. Chuẩn hóa Bước Nhận xét Nhanh & Giải pháp Cải thiện
Ngay khi kết thúc bất kỳ trò chơi nào trong 3 chế độ trên:
1. Hiển thị màn hình Tổng kết với điểm số, thời gian hoàn thành và danh sách câu làm sai.
2. Client gửi duy nhất mảng `mistakes[]` (không gửi lại toàn bộ giáo trình để phản hồi dưới 2 giây) vào `askPuterJSON()` để lấy về `{ ai_feedback, improvement_plan }`.
3. Hiển thị nút **"Luyện lại các câu vừa sai"** (tái sử dụng ngay mảng `mistakes[]` trong `React State` mà không cần gọi lại AI) và gọi `POST /api/analytics/feedback` lưu bản tóm tắt vào `user_course_analytics.feedback_history` trên Supabase.

---

## 4. Lộ trình Thực hiện 4 Giai đoạn

1. **Giai đoạn 1 (Database & Chính sách dọn dẹp):**
   * Chạy SQL tạo bảng `user_course_analytics` trên Supabase và cài `pg_cron` dọn `fcm_tokens`.
   * Bật **TTL Policy** cho trường `expires_at` trên Firebase Console cho các collection `moodle_document_parents`, `chat_sessions`, `learning_artifacts`.
2. **Giai đoạn 2 (Puter SDK & Dashboard Phân tích):**
   * Tích hợp `<PuterProvider />` và `lib/puter-client.ts` tương thích Vercel.
   * Viết API `/api/dashboard/grades` (kèm logic Lazy Cleanup các môn đã qua kỳ) và dựng giao diện Dashboard + tạo lộ trình 3 bước.
3. **Giai đoạn 3 (Cổng vào `quick_test`):**
   * Cài đặt cơ chế `lms_home_boot_id` trong `sessionStorage` tại Trang chủ và Trang Khóa học.
   * Dựng `QuickTestModal` đọc/ghi đè document `learning_artifacts/qt_${userId}_${courseId}` và đẩy nhận xét về Supabase.
4. **Giai đoạn 4 (Không gian Học tập 3 Mini-games):**
   * Xây dựng `<StudyGameRunner />` cùng 3 component `SpeedMatchingGame`, `SpotTheBugGame`, `RapidSwipeGame` và luồng sinh nhận xét nhanh sau ván chơi.