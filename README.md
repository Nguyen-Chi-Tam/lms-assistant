# 🎓 LMS Assistant - Intelligent AI Companion for Moodle LMS

[![Next.js](https://img.shields.io/badge/Next.js-16.2.6-black?style=flat-square&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19.2.6-blue?style=flat-square&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-v4-38bdf8?style=flat-square&logo=tailwindcss)](https://tailwindcss.com/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-0.45-C5F74F?style=flat-square&logo=drizzle)](https://orm.drizzle.team/)
[![Cloudinary](https://img.shields.io/badge/Cloudinary-Cloud_Storage-3448C5?style=flat-square&logo=cloudinary)](https://cloudinary.com/)
[![Moodle](https://img.shields.io/badge/Moodle_LMS-REST_API-F98012?style=flat-square&logo=moodle)](https://moodle.org/)

**LMS Assistant** là nền tảng trợ lý học tập và giảng dạy thông minh được tích hợp trực tiếp 2 chiều với **Moodle LMS**. Ứng dụng cung cấp giao diện hiện đại, trực quan, hỗ trợ sinh viên học tập đa phương thức với AI (Chatbot kèm tài liệu, Mindmap, Flashcards, Tóm tắt bài học, Trắc nghiệm ôn tập), đồng thời hỗ trợ giảng viên quản lý điểm số, nhập điểm tự động từ Excel bằng AI, và xuất ngân hàng đề thi chuẩn **Moodle XML**.

---

## 📑 Mục lục

1. [Tính năng nổi bật (Feature Tour)](#-tính-năng-nổi-bật-feature-tour)
   - [Dành cho Sinh viên (Student Experience)](#1-dành-cho-sinh-viên-student-experience)
   - [Dành cho Giảng viên (Teacher Portal)](#2-dành-cho-giảng-viên-teacher-portal)
   - [Tích hợp Đa mô hình AI (Multi-LLM Engine)](#3-tích-hợp-đa-mô-hình-ai-multi-llm-engine)
2. [Kiến trúc hệ thống & Công nghệ (Tech Stack)](#-kiến-trúc-hệ-thống--công-nghệ-tech-stack)
3. [Hướng dẫn cấu hình Moodle LMS (Chi tiết từng bước)](#-hướng-dẫn-cấu-hình-moodle-lms)
   - [Bước 1: Bật Web Services](#bước-1-bật-web-services)
   - [Bước 2: Bật giao thức REST](#bước-2-bật-giao-thức-rest)
   - [Bước 3: Bật Mobile Web Services](#bước-3-bật-mobile-web-services)
   - [Bước 4: Tạo External Service & Khai báo các hàm API](#bước-4-tạo-external-service--khai-báo-các-hàm-api)
   - [Bước 5: Cấp quyền & Tạo Web Service Token](#bước-5-cấp-quyền--tạo-web-service-token)
   - [Bước 6: Cấu hình quyền cập nhật điểm cho Giảng viên](#bước-6-cấu-hình-quyền-cập-nhật-điểm-cho-giảng-viên)
4. [Hướng dẫn cài đặt & Chạy dự án (Project Setup)](#-hướng-dẫn-cài-đặt--chạy-dự-án)
   - [Yêu cầu môi trường](#yêu-cầu-môi-trường)
   - [Cài đặt dependencies](#cài-đặt-dependencies)
   - [Cấu hình biến môi trường (`.env.local`)](#cấu-hình-biến-môi-trường-envlocal)
   - [Khởi tạo cơ sở dữ liệu](#khởi-tạo-cơ-sở-dữ-liệu)
   - [Chạy ứng dụng](#chạy-ứng-dụng)
5. [Cấu trúc thư mục dự án](#-cấu-trúc-thư-mục-dự-án)
6. [Xử lý sự cố thường gặp (Troubleshooting)](#-xử-lý-sự-cố-thường-gặp-troubleshooting)

---

## 🚀 Tính năng nổi bật (Feature Tour)

### 1. Dành cho Sinh viên (Student Experience)

- **Đồng bộ hóa trực tiếp từ Moodle**:
  - Tự động lấy danh sách khóa học đang theo học, tiến độ hoàn thành, và tài liệu học tập (PDF, DOCX, PPTX, liên kết bài giảng).
  - Lịch học và hạn chót bài tập/bài thi (`Upcoming Deadlines`) lấy từ Moodle Calendar theo thời gian thực.
  - Tra cứu bảng điểm chi tiết từng môn: điểm số, điểm tối đa, tỷ lệ %, trạng thái Đạt/Không đạt, cùng phản hồi (feedback) của giáo viên.
- **AI Gia sư thông minh (AI Tutor Chat)**:
  - Hỏi đáp ngữ cảnh sâu dựa trên tài liệu bài giảng và đề cương khóa học.
  - Hiển thị nguồn trích dẫn (`Citations`) chính xác từ các file bài giảng.
  - Hỗ trợ công thức toán học/khoa học dạng **LaTeX / KaTeX** sắc nét và định dạng Markdown chuẩn mực.
  - Tùy chọn chuyển đổi linh hoạt giữa các mô hình AI (Google Gemini, Groq Llama 3, OpenAI GPT, Anthropic Claude).
- **Bộ công cụ học tập tương tác (AI Study Artifacts)**:
  - **Tóm tắt bài học (Smart Summary)**: Tạo bản tóm tắt kiến thức cô đọng, có cấu trúc rõ ràng. Cho phép sao chép định dạng Word hoặc xuất trực tiếp ra file `.docx`.
  - **Bản đồ tư duy tương tác (Interactive Mindmap)**: Trực quan hóa cấu trúc bài học thành sơ đồ cây phân nhánh tương tác, thu gọn/mở rộng các nhánh, kéo thả/phóng to thu nhỏ và xuất ảnh PNG độ phân giải cao.
  - **Bộ thẻ ghi nhớ (Flashcards)**: Tự động trích xuất các thuật ngữ/định nghĩa quan trọng thành thẻ lật 2 mặt (Mặt trước: Câu hỏi/Khái niệm, Mặt sau: Câu trả lời/Ý nghĩa), kèm tính năng tự tạo thẻ riêng.
  - **Luyện tập trắc nghiệm (Practice Quiz)**: Tạo bài kiểm tra trắc nghiệm nhanh theo chủ đề yêu cầu, chấm điểm ngay lập tức và giải thích chi tiết từng câu.
  - **Bảng tra cứu nhanh (Cheat Sheet)**: Bảng tổng hợp công thức, định lý, phím tắt giúp ôn thi cấp tốc.
- **Thư viện tài liệu cá nhân (Personal Library)**:
  - Tải lên tài liệu tham khảo cá nhân lưu trữ đám mây qua **Cloudinary**.
  - Trích xuất nội dung văn bản thông minh từ file PDF (`unpdf`) và lưu cache phục vụ hỏi đáp với AI.

---

### 2. Dành cho Giảng viên (Teacher Portal)

Khi tài khoản Moodle mang vai trò Giảng viên (`teacher`, `editingteacher`) hoặc Quản trị viên (`admin`), hệ thống tự động kích hoạt **Teacher Portal** với các công cụ chuyên sâu:

- **Trợ lý Sư phạm AI (AI Teaching Assistant)**:
  - Hỗ trợ thiết kế đề cương học phần, phân phối kế hoạch bài giảng (Lesson Plan).
  - Đề xuất chủ đề thảo luận, bài tập thực hành, và xây dựng bảng tiêu chí chấm điểm (Rubric).
  - Soạn thảo thông báo khóa học, email nhắc nhở học tập chuyên nghiệp.
- **Bảng điểm Moodle tương tác (Interactive Gradebook)**:
  - Phản chiếu trực quan Sổ điểm (`Grader Report`) của Moodle theo từng môn học.
  - Tìm kiếm học viên theo tên/MSSV/email, sắp xếp theo thứ hạng điểm hoặc danh sách lớp.
  - Chỉnh sửa điểm số và lời nhận xét (Feedback) trực tiếp trên từng ô (Inline Edit).
  - Đồng bộ ngược điểm số hàng loạt lên Moodle chỉ với 1 cú click (`Save & Sync to Moodle`).
- **Nhập điểm thông minh từ Excel/CSV bằng AI (Smart Grade Importer)**:
  - Kéo thả file Excel (`.xlsx`, `.xls`) hoặc `.csv` bất kỳ (không cần chuẩn hóa cột trước).
  - Tự động nhận diện cột MSSV, Họ tên, Điểm số, Nhận xét qua thuật ngữ và phân tích ngữ nghĩa AI.
  - Thuật toán **Fuzzy Matching** đối soát và ghép cặp chính xác học viên trong file với danh sách thực tế trên Moodle.
  - Xem trước dữ liệu (Preview), kiểm tra tỷ lệ khớp và đẩy thẳng vào cột điểm Moodle tương ứng.
- **Tạo ngân hàng đề thi chuẩn Moodle XML (AI Quiz Generator)**:
  - Tự động sinh bộ câu hỏi trắc nghiệm đa dạng từ đề cương/tài liệu:
    - **Single Choice** (Trắc nghiệm chọn 1 đáp án đúng).
    - **True / False** (Đúng / Sai).
    - **Multiple Select** (Trắc nghiệm chọn nhiều đáp án đúng, tự động phân bổ tỷ lệ % điểm cộng cho đáp án đúng và điểm trừ cho đáp án sai để tránh gian lận).
  - Tùy chỉnh mức độ khó (Dễ, Trung bình, Khó, Vận dụng cao), số lượng câu hỏi và lời giải chi tiết.
  - **Xuất file `.xml` chuẩn định dạng Moodle XML**: Nhập trực tiếp vào Ngân hàng câu hỏi (`Question Bank`) của Moodle mà không phát sinh lỗi định dạng.

---

### 3. Tích hợp Đa mô hình AI (Multi-LLM Engine)

LMS Assistant hỗ trợ linh hoạt 4 nhà cung cấp AI hàng đầu thế giới:
- **Google Gemini** (`gemini-3.8-flash`, `gemini-3.1-pro-preview`): Xử lý ngữ cảnh dài, trích xuất tài liệu học tập tốc độ cao.
- **Groq** (`llama-3.3-70b-versatile`, `mixtral-8x7b-32768`): Tốc độ phản hồi cực nhanh, độ trễ siêu thấp cho hội thoại gia sư.
- **OpenAI** (`gpt-4o`, `gpt-4o-mini`): Phân tích dữ liệu học tập phức tạp, phân tích bảng điểm, suy luận toán học.
- **Anthropic Claude** (`claude-3-5-sonnet`): Văn phong sư phạm xuất sắc, phân tích tài liệu học thuật chuyên sâu.

---

## 🛠 Kiến trúc hệ thống & Công nghệ (Tech Stack)

| Thành phần | Công nghệ / Thư viện | Vai trò |
| :--- | :--- | :--- |
| **Frontend Framework** | Next.js 16 (App Router) + React 19 | Giao diện SSR & Client Components hiệu năng cao |
| **Styling & Icons** | Tailwind CSS v4 + Lucide Icons | Thiết kế giao diện hiện đại, phản hồi tốt trên Desktop & Mobile |
| **Bundler & Tooling** | Vinext / Vite 8 + TypeScript 5.9 | Tốc độ biên dịch siêu nhanh, kiểm soát kiểu chặt chẽ |
| **LMS Core** | Moodle REST Web Services API | Đồng bộ khóa học, người dùng, tài liệu, sổ điểm, lịch học |
| **Database & ORM** | Supabase (PostgreSQL) + Drizzle ORM | Lưu trữ người dùng, phiên chat, artifacts và cache tài liệu |
| **Cloud Storage** | Cloudinary SDK v2 | Lưu trữ tài liệu, hình ảnh, bài giảng trên đám mây |
| **Document Parsing** | `unpdf`, `xlsx`, `docx` | Đọc file PDF, Excel bảng điểm và xuất tài liệu Word |
| **Scientific Rendering** | KaTeX, `rehype-katex`, `remark-math` | Hiển thị công thức Toán, Lý, Hóa chuẩn LaTeX |

---

## 🔧 Hướng dẫn cấu hình Moodle LMS

Để ứng dụng LMS Assistant kết nối và trao đổi dữ liệu hai chiều với Moodle, bạn cần bật các tính năng Web Services trên site Moodle của mình.

### Bước 1: Bật Web Services
1. Đăng nhập Moodle với tài khoản **Administrator**.
2. Truy cập: **Site administration (Quản trị khu vực)** > **General (Chung)** > **Advanced features (Các tính năng nâng cao)**.
3. Tìm mục **Enable web services (Bật dịch vụ web)** và tích chọn `[x]`.
4. Nhấn **Save changes (Lưu thay đổi)**.

### Bước 2: Bật giao thức REST
1. Truy cập: **Site administration** > **Server** (hoặc **Plugins**) > **Web services** > **Manage protocols (Quản lý các giao thức)**.
2. Tại dòng **REST protocol**, bật biểu tượng con mắt (mở) để kích hoạt giao thức REST.
3. Nhấn **Save changes**.

### Bước 3: Bật Mobile Web Services
*Bước này cho phép học viên/giảng viên đăng nhập trực tiếp vào hệ thống bằng tài khoản và mật khẩu Moodle của họ.*
1. Truy cập: **Site administration** > **General** > **Mobile app** > **Mobile settings**.
2. Tích chọn **Enable web services for mobile devices (`enablemobilewebservice`)**.
3. Nhấn **Save changes**.

### Bước 4: Tạo External Service & Khai báo các hàm API
1. Truy cập: **Site administration** > **Server** > **Web services** > **External services**.
2. Nhấn **Add (Thêm)** để tạo một dịch vụ mới:
   - **Name**: `LMS Assistant Service`
   - **Short name**: `lms_assistant`
   - **Enabled**: Tích chọn `[x]`
   - **Authorized users only**: Bỏ tích (hoặc tích chọn nếu bạn gán tài khoản cụ thể)
   - Nhấn **Add service**.
3. Nhấp vào liên kết **Functions (Các hàm)** bên cạnh dịch vụ vừa tạo, sau đó nhấn **Add functions** và thêm đầy đủ các hàm API sau:

| Tên hàm Moodle API | Mục đích sử dụng trong LMS Assistant |
| :--- | :--- |
| `core_webservice_get_site_info` | Lấy thông tin user đăng nhập, quyền hạn, họ tên, avatar |
| `core_enrol_get_users_courses` | Lấy danh sách khóa học mà học viên/giáo viên tham gia |
| `core_enrol_get_enrolled_users` | Lấy danh sách toàn bộ học viên trong khóa học phục vụ nhập điểm |
| `core_course_get_contents` | Tải nội dung bài học, tài liệu PDF/Word/Slide bài giảng |
| `core_calendar_get_calendar_upcoming_view` | Lấy danh sách lịch thi, deadline bài tập sắp tới |
| `gradereport_user_get_grade_items` | Lấy chi tiết điểm số, cột điểm và nhận xét của học viên |
| `core_grades_update_grades` | Cập nhật điểm số và nhận xét từ hệ thống lên sổ điểm Moodle |
| `core_user_get_users_by_field` | Truy vấn thông tin chi tiết và avatar của người dùng |

### Bước 5: Cấp quyền & Tạo Web Service Token
1. Truy cập: **Site administration** > **Server** > **Web services** > **Manage tokens**.
2. Nhấn **Add (Thêm)**:
   - **User**: Chọn tài khoản quản trị viên hoặc tài khoản đại diện hệ thống.
   - **Service**: Chọn `LMS Assistant Service` (hoặc `Moodle mobile web service`).
   - **Valid until**: Để trống (không giới hạn thời gian) hoặc chọn thời hạn mong muốn.
3. Nhấn **Save changes**.
4. Sao chép chuỗi mã Token vừa tạo (ví dụ: `55066767d5f2da3e61bbf8ffd96f48ae`) để dán vào biến `MOODLE_TOKEN` trong file `.env.local`.

### Bước 6: Cấu hình quyền cập nhật điểm cho Giảng viên
Để chức năng đẩy điểm từ Excel (`core_grades_update_grades`) hoạt động trơn tru:
1. Truy cập: **Site administration** > **Users** > **Permissions** > **Define roles**.
2. Chọn vai trò **Teacher** (hoặc **Editing teacher**) > nhấn **Edit**.
3. Đảm bảo các quyền (capabilities) sau ở trạng thái **Allow (Cho phép)**:
   - `moodle/grade:edit`
   - `moodle/grade:viewall`
   - `webservice/rest:use`

---

## 💻 Hướng dẫn cài đặt & Chạy dự án

### Yêu cầu môi trường
- **Node.js**: Phiên bản `>= 22.13.0` (khuyến nghị Node LTS mới nhất).
- **npm** (đi kèm Node.js) hoặc **pnpm** / **yarn**.
- Một instance **Moodle** (cài đặt cục bộ qua XAMPP/Docker hoặc server trực tuyến).
- Tài khoản **Cloudinary** (miễn phí) để lưu trữ file.
- Tài khoản **Supabase** (miễn phí) hoặc cơ sở dữ liệu PostgreSQL.

### Cài đặt dependencies

```bash
# Clone dự án từ GitHub
git clone https://github.com/your-username/lms-assistant.git
cd lms-assistant

# Cài đặt các gói phụ thuộc
npm install
```

### Cấu hình biến môi trường (`.env.local`)

Sao chép file mẫu `.env.example` thành `.env.local`:

```bash
cp .env.example .env.local
```

Mở file `.env.local` và điền các thông tin bí mật của bạn:

```env
# ==============================================================================
# DATABASE (Supabase PostgreSQL & Drizzle ORM)
# ==============================================================================
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT].supabase.co:5432/postgres
NEXT_PUBLIC_SUPABASE_URL=https://[YOUR-PROJECT].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# ==============================================================================
# STORAGE (Cloudinary - Quản lý tài liệu & đa phương tiện)
# Lấy tại Cloudinary Dashboard: Settings (⚙️) -> Access Keys
# ==============================================================================
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CLOUDINARY_URL=cloudinary://your_api_key:your_api_secret@your_cloud_name

# ==============================================================================
# MOODLE LMS INTEGRATION
# ==============================================================================
MOODLE_URL=http://localhost:8080      # Hoặc địa chỉ domain Moodle của bạn
MOODLE_TOKEN=your_moodle_wstoken_here # Token tạo ở Bước 5

# ==============================================================================
# AI PROVIDERS (Điền ít nhất 1 nhà cung cấp để sử dụng AI)
# ==============================================================================
# Google Gemini (Khuyến nghị): https://aistudio.google.com/apikey
GEMINI_API_KEY=AIzaSy...
GOOGLE_API_KEY=AIzaSy...

# Groq (Tốc độ cao): https://console.groq.com/keys
GROQ_API_KEY=gsk_...

# OpenAI: https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-proj-...

# Anthropic Claude: https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=sk-ant-...
```

> [!IMPORTANT]
> File `.env.local` đã được cấu hình trong `.gitignore` để không bao giờ bị đẩy lên GitHub, giúp bảo vệ an toàn tuyệt đối các khóa API của bạn.

### Khởi tạo cơ sở dữ liệu

Dự án sử dụng **Drizzle ORM** kết nối trực tiếp với PostgreSQL. Chạy lệnh sau để đồng bộ schema:

```bash
# Tạo các migration file từ schema
npm run db:generate
```

### Chạy ứng dụng

```bash
# Chạy môi trường phát triển (Development Mode)
npm run dev

# Hoặc xây dựng bản phát hành (Production Build)
npm run build
npm start
```

Mở trình duyệt và truy cập: **`http://localhost:3000`**

- Bạn có thể nhấn **"Đăng nhập với Moodle"** để xác thực trực tiếp bằng tài khoản Moodle.
- Hoặc sử dụng chế độ **Khám phá bản thử nghiệm (Demo Preview)** để xem trước giao diện và dữ liệu mẫu nếu chưa kết nối Moodle.

---

## 📁 Cấu trúc thư mục dự án

```text
lms-assistant/
├── app/
│   ├── (pages)/
│   │   ├── course/page.tsx           # Trang chi tiết khóa học, AI Tutor, Flashcard, Mindmap
│   │   ├── home/page.tsx             # Dashboard sinh viên, tiến độ, deadline, tài liệu
│   │   └── login/page.tsx            # Trang đăng nhập tích hợp Moodle REST Auth
│   ├── api/
│   │   ├── documents/                # API xử lý và cache nội dung tài liệu PDF/Word
│   │   ├── library/                  # API upload tài liệu lên Cloudinary
│   │   ├── login/                    # API xác thực Moodle token
│   │   ├── moodle/                   # API đồng bộ khóa học, tài nguyên, điểm số, avatar
│   │   ├── quiz/                     # API sinh đề kiểm tra ôn tập cho sinh viên
│   │   ├── study-tools/              # API tạo tóm tắt, mindmap, flashcards bằng AI
│   │   ├── teacher/
│   │   │   ├── assistant/            # API trợ lý sư phạm AI (giáo án, rubrics, thông báo)
│   │   │   ├── grades/import/        # API trích xuất điểm từ Excel/CSV bằng AI & heuristics
│   │   │   ├── grades/update/        # API đồng bộ điểm hàng loạt vào Moodle gradebook
│   │   │   ├── quiz/generate/        # API tạo câu hỏi trắc nghiệm & xuất Moodle XML
│   │   │   └── students/             # API lấy danh sách học viên & cột điểm từ Moodle
│   │   └── tutor/                    # API Chatbot gia sư AI hỗ trợ đa mô hình
│   ├── components/
│   │   ├── CourseCard.tsx            # Thẻ hiển thị khóa học kèm tiến độ
│   │   ├── InteractiveMindmap.tsx    # Sơ đồ tư duy tương tác kèm chức năng xuất ảnh PNG
│   │   ├── MarkdownRenderer.tsx      # Bộ render văn bản Markdown & công thức LaTeX
│   │   ├── QuizComponent.tsx         # Giao diện làm bài kiểm tra trắc nghiệm
│   │   └── teacher/
│   │       └── TeacherPortal.tsx     # Toàn bộ giao diện Teacher Portal (Sổ điểm, Nhập Excel, Tạo đề thi)
│   ├── lib/
│   │   └── moodle-xml.ts             # Bộ chuyển đổi câu hỏi sang định dạng Moodle XML chuẩn
│   ├── globals.css                   # Định kiểu CSS toàn cục và biến giao diện
│   └── layout.tsx                    # Root Layout của ứng dụng Next.js
├── db/
│   ├── index.ts                      # Kết nối PostgreSQL client
│   ├── runtime.ts                    # Trình quản lý biến môi trường runtime
│   └── schema.ts                     # Định nghĩa lược đồ Drizzle ORM (Users, Courses, Documents,...)
├── lib/
│   ├── cloudinary.ts                 # Cấu hình SDK Cloudinary & upload stream
│   ├── export-utils.ts               # Bộ tiện ích xuất file Word (.docx) và clipboard HTML
│   └── supabase.ts                   # Cấu hình client Supabase
├── models/
│   ├── gemini.ts                     # Tích hợp Google Gemini SDK
│   ├── groq.ts                       # Tích hợp Groq SDK
│   ├── openai.ts                     # Tích hợp OpenAI SDK
│   └── anthropic.ts                  # Tích hợp Anthropic Claude SDK
├── .env.example                      # File mẫu biến môi trường
├── .gitignore                        # Cấu hình bỏ qua các file nhạy cảm và build artifacts
├── drizzle.config.ts                 # Cấu hình Drizzle Kit
├── package.json                      # Thông tin dự án và danh sách dependencies
└── README.md                         # Tài liệu hướng dẫn sử dụng và cài đặt
```

---

## ❓ Xử lý sự cố thường gặp (Troubleshooting)

### 1. Lỗi kết nối Moodle (`Mất kết nối tới hệ thống Moodle` hoặc `502 Bad Gateway`)
- **Nguyên nhân**: Địa chỉ `MOODLE_URL` không chính xác hoặc Moodle chưa bật Web Services.
- **Cách khắc phục**:
  - Đảm bảo Moodle đang hoạt động và có thể truy cập được từ trình duyệt.
  - Nếu chạy Moodle qua localhost hoặc Docker trên Windows, hãy thử dùng IP máy chủ hoặc `http://127.0.0.1:[port]` thay vì `localhost`.
  - Kiểm tra xem đã bật REST Protocol trong **Site administration > Server > Web services > Manage protocols** chưa.

### 2. Lỗi `Access control exception` hoặc `The service is not available` khi đăng nhập
- **Nguyên nhân**: Dịch vụ `moodle_mobile_app` chưa được kích hoạt cho ứng dụng di động.
- **Cách khắc phục**: Vào **Site administration > General > Mobile app > Mobile settings**, tích chọn **Enable web services for mobile devices**.

### 3. Lỗi không cập nhật được điểm số lên Moodle (`core_grades_update_grades`)
- **Nguyên nhân**: Tài khoản Moodle chưa được cấp quyền chỉnh sửa điểm số trong Web Services.
- **Cách khắc phục**:
  - Đảm bảo hàm `core_grades_update_grades` đã được thêm vào External Service.
  - Kiểm tra quyền `moodle/grade:edit` của vai trò Giảng viên trong khóa học đó.
  - Nếu gặp thông báo quyền hạn, ứng dụng vẫn kích hoạt chế độ dự phòng an toàn (Simulation Mode) để không làm gián đoạn trải nghiệm của giáo viên.

### 4. Lỗi upload ảnh hoặc tài liệu lên Cloudinary
- **Nguyên nhân**: Khóa `CLOUDINARY_API_KEY` hoặc `CLOUDINARY_API_SECRET` bị điền sai hoặc chứa khoảng trắng thừa.
- **Cách khắc phục**: Kiểm tra lại Cloud Name, API Key, API Secret trong trang tổng quan của Cloudinary Dashboard và cập nhật lại vào `.env.local`.

---

## 📄 Bản quyền (License)

Dự án được phát hành dưới giấy phép mã nguồn mở **MIT License**. Mọi đóng góp (Pull Requests) hoặc báo cáo lỗi (Issues) đều được hoan nghênh!

---
*Phát triển với niềm đam mê nâng cao trải nghiệm giáo dục số và ứng dụng AI trong giảng dạy.* 🚀

