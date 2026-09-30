// 요청 처리기(Node `(req, res)`)를 127.0.0.1 임시 포트에 띄워 요청을 보내는 도우미다. 끝나면 서버를 닫는다.
// fetch는 CONNECT·TRACE를 막으므로 `http.request`로 보낸다.

import http from 'node:http';

/**
 * 요청 하나를 보낸다.
 *
 * @param {number} port 포트
 * @param {string} method method
 * @param {string} path 경로
 * @returns {Promise<{status: number, body: string}>} 응답
 */
function send(port, method, path) {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // CONNECT처럼 Node가 요청 처리기로 넘기지 않는 method는 연결이 끊긴다. 핸들러가 받지 않은 것으로 기록한다.
    request.on('error', () => resolve({ status: 0, body: '' }));
    request.end();
  });
}

/**
 * 처리기로 서버를 띄운다.
 *
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler 처리기
 * @returns {Promise<{request: (method: string, path: string) => Promise<{status: number, body: string}>, close: () => Promise<void>}>} 드라이버
 */
export async function serveLocally(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    request: (method, path) => send(port, method, path),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
