/**
 * Moodle Role Evaluation & Resolution Service
 *
 * Implements the system role & cohort division rule:
 * 1. Quản trị -> Giáo viên (teacher)
 * 2. Thành viên có vai trò Người quản lý, Giáo viên, Giáo viên trợ giảng -> Giáo viên (teacher)
 * 3. Thành viên có vai trò Học viên, không có vai trò -> Học viên (student)
 */

export type ResolvedRole = 'teacher' | 'student';

export interface MoodleRoleItem {
  roleid?: number;
  name?: string;
  shortname?: string;
  sortorder?: number;
}

const TEACHER_SHORTNAMES = new Set([
  'editingteacher',
  'teacher',
  'manager',
  'coursecreator',
  'admin',
]);

const TEACHER_NAME_PATTERNS = [
  /quản lý/i,
  /người quản lý/i,
  /giáo viên/i,
  /trợ giảng/i,
  /admin/i,
  /quản trị/i,
];

/**
 * Pure function evaluating a user's role against the 3 rules.
 */
export function evaluateMoodleRole(params: {
  isSiteAdmin?: boolean | number;
  userId?: number;
  roles?: MoodleRoleItem[];
}): ResolvedRole {
  const { isSiteAdmin, userId, roles } = params;

  // Rule 1: Quản trị -> Giáo viên
  if (Boolean(isSiteAdmin) || userId === 2) {
    return 'teacher';
  }

  if (Array.isArray(roles) && roles.length > 0) {
    for (const r of roles) {
      const sname = (r.shortname || '').toLowerCase().trim();
      const rname = (r.name || '').toLowerCase().trim();

      // Rule 1: Quản trị shortname / name
      if (sname.includes('admin') || rname.includes('quản trị')) {
        return 'teacher';
      }

      // Rule 2: Thành viên có vai trò Người quản lý, Giáo viên, Giáo viên trợ giảng -> Giáo viên
      if (TEACHER_SHORTNAMES.has(sname)) {
        return 'teacher';
      }
      if (TEACHER_NAME_PATTERNS.some(p => p.test(rname))) {
        return 'teacher';
      }
    }
  }

  // Rule 3: Thành viên có vai trò Học viên, không có vai trò -> Học viên
  return 'student';
}

/**
 * Resolves a user's role by combining system role with cohorts (Course 1 - Site frontpage / cohorts container).
 * Uses user's token or fallback system token to query `core_user_get_course_user_profiles`.
 */
export async function resolveUserMoodleRole(params: {
  moodleBaseUrl: string;
  token: string;
  userId: number;
  isSiteAdmin?: boolean | number;
  fallbackToken?: string;
}): Promise<ResolvedRole> {
  const { moodleBaseUrl, token, userId, isSiteAdmin, fallbackToken } = params;

  // Fast check: Rule 1 Quản trị
  if (Boolean(isSiteAdmin) || userId === 2) {
    return 'teacher';
  }

  const cleanBaseUrl = moodleBaseUrl.replace(/\/$/, '');
  const tokensToTry = [token, fallbackToken].filter((t): t is string => Boolean(t && t.trim()));

  for (const t of tokensToTry) {
    try {
      // Query user profile in Course 1 (Site Home / Cohorts where all site users are assigned their cohorts/roles)
      const sp = new URLSearchParams({
        wstoken: t,
        wsfunction: 'core_user_get_course_user_profiles',
        moodlewsrestformat: 'json',
        'userlist[0][userid]': String(userId),
        'userlist[0][courseid]': '1',
      });

      const res = await fetch(`${cleanBaseUrl}/webservice/rest/server.php?${sp.toString()}`, {
        headers: { Accept: 'application/json' },
      });

      if (res.ok) {
        const data = (await res.json()) as Array<{ id: number; roles?: MoodleRoleItem[] }> | { exception?: string };
        if (Array.isArray(data) && data.length > 0) {
          const userProfile = data[0];
          const evaluated = evaluateMoodleRole({
            isSiteAdmin,
            userId,
            roles: userProfile.roles,
          });
          return evaluated;
        }
      }
    } catch (err) {
      console.warn(`[resolveUserMoodleRole] Error checking Course 1 profile with token:`, err);
    }
  }

  // If Course 1 lookup was inconclusive, check if the user is a teacher in any enrolled courses
  for (const t of tokensToTry) {
    try {
      const sp = new URLSearchParams({
        wstoken: t,
        wsfunction: 'core_enrol_get_users_courses',
        moodlewsrestformat: 'json',
        userid: String(userId),
      });

      const res = await fetch(`${cleanBaseUrl}/webservice/rest/server.php?${sp.toString()}`, {
        headers: { Accept: 'application/json' },
      });

      if (res.ok) {
        const enrolledCourses = (await res.json()) as Array<{ id: number }>;
        if (Array.isArray(enrolledCourses) && enrolledCourses.length > 0) {
          // If user has any enrolled courses, check their role in those courses
          const courseProfileParams = new URLSearchParams({
            wstoken: t,
            wsfunction: 'core_user_get_course_user_profiles',
            moodlewsrestformat: 'json',
          });

          enrolledCourses.slice(0, 10).forEach((c, idx) => {
            courseProfileParams.set(`userlist[${idx}][userid]`, String(userId));
            courseProfileParams.set(`userlist[${idx}][courseid]`, String(c.id));
          });

          const profRes = await fetch(`${cleanBaseUrl}/webservice/rest/server.php?${courseProfileParams.toString()}`, {
            headers: { Accept: 'application/json' },
          });

          if (profRes.ok) {
            const profData = (await profRes.json()) as Array<{ id: number; roles?: MoodleRoleItem[] }>;
            if (Array.isArray(profData)) {
              for (const p of profData) {
                if (evaluateMoodleRole({ isSiteAdmin: false, userId, roles: p.roles }) === 'teacher') {
                  return 'teacher';
                }
              }
            }
          }
        }
      }
    } catch (enrolErr) {
      console.warn(`[resolveUserMoodleRole] Error checking enrolled courses:`, enrolErr);
    }
  }

  // Default to student if no teacher role detected
  return 'student';
}

