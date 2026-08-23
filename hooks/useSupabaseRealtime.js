import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export function useSupabaseRealtime(roomId) {
  const [lastChange, setLastChange] = useState(null)

  useEffect(() => {
    if (!supabase || !roomId) return undefined
    const channel = supabase
      .channel(`room:${roomId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, setLastChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `room_id=eq.${roomId}` }, setLastChange)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [roomId])

  return { lastChange, isConnected: Boolean(supabase && roomId) }
}
