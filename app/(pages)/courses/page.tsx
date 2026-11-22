import { redirect } from 'next/navigation';

export default function CoursesPage() {
  redirect('/home?tab=courses');
}
