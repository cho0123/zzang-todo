/* 검증용 가짜 Auth — firebase-auth.js 자리에 끼워 넣는다.
   바로 로그인된 것으로 쳐서 로그인 화면을 지나간다. 실제 계정에 닿지 않는다.
   쓰는 법은 같은 폴더의 README.md 참고. */

const USER = { uid: 'tester', email: 'tester@example.com' };

export function getAuth() { return { currentUser: USER }; }
export async function signInWithEmailAndPassword() { return { user: USER }; }
export async function signOut() {}
export function onAuthStateChanged(auth, cb) {
    setTimeout(() => cb(USER), 0);
    return () => {};
}
