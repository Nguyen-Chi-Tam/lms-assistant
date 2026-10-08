import { NextResponse } from 'next/server';
import { runtimeEnv } from '../../../../db/runtime';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokenFromQuery = searchParams.get('token');
  const requestedId = searchParams.get('id') || searchParams.get('userId') || searchParams.get('v');
  const authorization = request.headers.get('authorization');
  const clientToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const { MOODLE_URL, MOODLE_TOKEN } = runtimeEnv();
  let activeToken: string = tokenFromQuery || clientToken || MOODLE_TOKEN || '';

  if (!MOODLE_URL || !activeToken) {
    return new NextResponse('Missing Moodle credentials', { status: 401 });
  }

  const moodleBase = MOODLE_URL.replace(/\/$/, '');

  try {
    // 1. Check if token works via core_webservice_get_site_info
    let siteParams = new URLSearchParams({
      wstoken: activeToken,
      wsfunction: 'core_webservice_get_site_info',
      moodlewsrestformat: 'json',
    });
    let siteRes = await fetch(`${moodleBase}/webservice/rest/server.php?${siteParams.toString()}`);
    let siteData = siteRes.ok
      ? ((await siteRes.json()) as { userid?: number; userpictureurl?: string; errorcode?: string; exception?: string })
      : null;

    // Fallback to server MOODLE_TOKEN if client token is invalid or expired
    if ((!siteData || siteData.errorcode === 'invalidtoken' || siteData.exception) && MOODLE_TOKEN && activeToken !== MOODLE_TOKEN) {
      activeToken = MOODLE_TOKEN;
      siteParams = new URLSearchParams({
        wstoken: activeToken,
        wsfunction: 'core_webservice_get_site_info',
        moodlewsrestformat: 'json',
      });
      siteRes = await fetch(`${moodleBase}/webservice/rest/server.php?${siteParams.toString()}`);
      siteData = siteRes.ok
        ? ((await siteRes.json()) as { userid?: number; userpictureurl?: string; errorcode?: string; exception?: string })
        : null;
    }

    if (!siteRes.ok || !siteData || siteData.errorcode || siteData.exception) {
      return new NextResponse('Failed to connect to Moodle', { status: 502 });
    }

    const userid = requestedId ? Number(requestedId) : siteData.userid;
    let targetUrl = !requestedId || Number(requestedId) === siteData.userid ? siteData.userpictureurl : undefined;

    // 2. Fetch full user profile to get high-res profileimageurl
    if (userid) {
      try {
        const userParams = new URLSearchParams({
          wstoken: activeToken,
          wsfunction: 'core_user_get_users_by_field',
          field: 'id',
          'values[0]': String(userid),
          moodlewsrestformat: 'json',
        });
        const userRes = await fetch(`${moodleBase}/webservice/rest/server.php?${userParams.toString()}`);
        if (userRes.ok) {
          const users = (await userRes.json()) as Array<{ profileimageurl?: string; profileimageurlsmall?: string }>;
          if (users?.[0]?.profileimageurl) {
            targetUrl = users[0].profileimageurl;
          }
        }
      } catch {
        // fallback to targetUrl
      }
    }

    if (!targetUrl) {
      return new NextResponse('No picture URL available', { status: 404 });
    }

    // 3. Ensure webservice token is attached and URL points to webservice endpoint if needed
    let fetchUrl = targetUrl;
    if (fetchUrl.includes('/pluginfile.php') && !fetchUrl.includes('/webservice/pluginfile.php')) {
      fetchUrl = fetchUrl.replace('/pluginfile.php', '/webservice/pluginfile.php');
    }
    if (!fetchUrl.includes('token=')) {
      fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + `token=${encodeURIComponent(activeToken)}`;
    }

    // 4. Fetch the image directly from Moodle
    let imgRes = await fetch(fetchUrl);
    if (!imgRes.ok && fetchUrl !== targetUrl) {
      // Try original URL with token as fallback
      const altUrl = targetUrl + (targetUrl.includes('?') ? '&' : '?') + `token=${encodeURIComponent(activeToken)}`;
      const altRes = await fetch(altUrl);
      if (altRes.ok) {
        imgRes = altRes;
      }
    }

    if (!imgRes.ok) {
      return new NextResponse('Could not fetch avatar from Moodle', { status: imgRes.status });
    }

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const buffer = await imgRes.arrayBuffer();

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    });
  } catch (error: any) {
    return new NextResponse(`Error fetching avatar: ${error?.message || 'Internal server error'}`, { status: 500 });
  }
}
