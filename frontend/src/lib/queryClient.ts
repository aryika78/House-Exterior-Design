import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,        // 30s before refetch
      retry: 1,
      refetchOnWindowFocus: false,  // avoid Supabase auth reload race
    },
  },
})
