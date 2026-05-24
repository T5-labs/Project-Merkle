// Re-export from the JSX implementation so that imports using `@/lib/client/error-toast`
// (without extension) continue to resolve — TypeScript bundler resolution picks `.ts`
// before `.tsx` when both exist, so this thin re-export bridges the gap.
export { showErrorToast } from './error-toast.tsx';
