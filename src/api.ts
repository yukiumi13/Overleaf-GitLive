import fetch from 'node-fetch';
import * as https from 'https';
import * as http from 'http';
import { SessionManager } from './sessionManager';

function getAgent(url: string) {
    return url.startsWith('https') ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
}

export interface Credentials {
    serverUrl: string;
    cookies: string;
    csrfToken: string;
}

export interface Identity extends Credentials {
    projectId: string;
    rootResourcePath: string;
}

export async function loginWithCookies(serverUrl: string, cookies: string): Promise<{ success: boolean; creds?: Credentials; error?: string }> {
    try {
        const res = await fetch(`${serverUrl}/project`, {
            method: 'GET',
            redirect: 'manual',
            agent: getAgent(serverUrl),
            headers: {
                'Connection': 'keep-alive',
                'Cookie': cookies,
            },
        });
        const body = await res.text();
        const csrfMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/)
            || body.match(/<input.*name="_csrf".*value="([^"]*)">/)
            || body.match(/"csrfToken"\s*:\s*"([^"]*)"/);
        if (!csrfMatch) {
            return { success: false, error: 'Failed to extract CSRF token. Cookies may be invalid or expired.' };
        }
        return {
            success: true,
            creds: { serverUrl, cookies, csrfToken: csrfMatch[1] },
        };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

export interface ProjectInfo {
    id: string;
    name: string;
    lastUpdated: string;
    owner?: { firstName?: string; lastName?: string };
}

export interface OutputFile {
    path: string;
    url: string;
    type: string;
    build: string;
}

export interface CompileResult {
    success: boolean;
    buildId?: string;
    outputFiles?: OutputFile[];
    pdfUrl?: string;
    clsiServerId?: string;
    error?: string;
}

export async function fetchProjects(creds: Credentials): Promise<{ success: boolean; projects?: ProjectInfo[]; error?: string }> {
    const { serverUrl, cookies } = creds;
    try {
        const res = await fetch(`${serverUrl}/user/projects`, {
            method: 'GET',
            redirect: 'manual',
            agent: getAgent(serverUrl),
            headers: {
                'Connection': 'keep-alive',
                'Cookie': cookies,
            },
        });
        if (res.status !== 200) {
            return { success: false, error: `Fetch projects failed: ${res.status}` };
        }
        const data = await res.json() as any;
        const projects: ProjectInfo[] = (data.projects || []).map((p: any) => ({
            id: p._id || p.id,
            name: p.name,
            lastUpdated: p.lastUpdated,
            owner: p.owner,
        }));
        return { success: true, projects };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

export async function compile(identity: Identity, session?: SessionManager): Promise<CompileResult> {
    if (session) { await session.ensureFreshToken(); }
    const id = session ? session.identity : identity;
    const { serverUrl, projectId, cookies, csrfToken } = id;
    const url = `${serverUrl}/project/${projectId}/compile?auto_compile=true`;

    const body = JSON.stringify({
        _csrf: csrfToken,
        check: 'silent',
        draft: false,
        incrementalCompilesEnabled: true,
        rootResourcePath: id.rootResourcePath,
        stopOnFirstError: false,
    });

    const doCompile = async (): Promise<CompileResult> => {
        const currentId = session ? session.identity : identity;
        const res = await fetch(url, {
            method: 'POST',
            redirect: 'manual',
            agent: getAgent(serverUrl),
            headers: {
                'Connection': 'keep-alive',
                'Cookie': currentId.cookies,
                'Content-Type': 'application/json',
                'X-Csrf-Token': currentId.csrfToken,
            },
            body: JSON.stringify({
                _csrf: currentId.csrfToken,
                check: 'silent',
                draft: false,
                incrementalCompilesEnabled: true,
                rootResourcePath: currentId.rootResourcePath,
                stopOnFirstError: false,
            }),
        });

        if (session) { await session.captureCookies(res.headers); }

        if (res.status === 403 || res.status === 401) {
            return { success: false, error: `auth_error:${res.status}` };
        }

        if (res.status !== 200) {
            const errBody = await res.text().catch(() => '');
            return { success: false, error: `Compile failed (${res.status}): ${errBody.slice(0, 200)}` };
        }

        const data = await res.json() as any;
        if (data.status !== 'success') {
            return { success: false, error: `Compile status: ${data.status}` };
        }

        const outputFiles: OutputFile[] = data.outputFiles || [];
        const pdfFile = outputFiles.find((f: OutputFile) => f.path === 'output.pdf');
        const buildId = outputFiles[0]?.url?.match(/\/build\/([^/]+)/)?.[1];

        return {
            success: true,
            buildId,
            outputFiles,
            pdfUrl: pdfFile?.url,
            clsiServerId: data.clsiServerId,
        };
    };

    try {
        let result = await doCompile();
        // Auto-retry on auth error with refreshed token
        if (!result.success && result.error?.startsWith('auth_error:') && session) {
            const refreshed = await session.handleAuthError();
            if (refreshed) {
                result = await doCompile();
            }
        }
        return result;
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

export async function downloadPdf(
    serverUrl: string,
    cookies: string,
    pdfUrl: string,
    session?: SessionManager,
    clsiServerId?: string,
): Promise<Buffer> {
    const base = `${serverUrl}/${pdfUrl.replace(/^\/+/, '')}`;
    const url = clsiServerId
        ? `${base}${base.includes('?') ? '&' : '?'}clsiserverid=${encodeURIComponent(clsiServerId)}`
        : base;
    const agent = getAgent(serverUrl);
    const maxRetries = 4;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const currentCookies = session ? session.identity.cookies : cookies;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const res = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                agent,
                signal: controller.signal as any,
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': currentCookies,
                    'Accept': 'application/pdf',
                },
            });

            if (session) { await session.captureCookies(res.headers); }

            if (res.status === 200 || res.status === 206) {
                const buf = await res.buffer();
                if (buf.length < 100) {
                    throw new Error(`PDF too small (${buf.length} bytes), likely incomplete`);
                }
                return buf;
            } else if (res.status === 404) {
                throw new Error('PDF not found (404). Compile may still be in progress.');
            } else if ((res.status === 401 || res.status === 403) && session) {
                const refreshed = await session.handleAuthError();
                if (refreshed && attempt < maxRetries - 1) { continue; }
                throw new Error(`Auth error (${res.status}). Cookie may have expired.`);
            } else if (res.status === 401 || res.status === 403) {
                throw new Error(`Auth error (${res.status}). Cookie may have expired.`);
            } else {
                throw new Error(`Download failed: HTTP ${res.status}`);
            }
        } catch (err: any) {
            const isLast = attempt === maxRetries - 1;
            if (isLast) { throw err; }
            const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
            await new Promise(r => setTimeout(r, delay));
        } finally {
            clearTimeout(timeout);
        }
    }

    throw new Error('Download failed after all retries');
}
