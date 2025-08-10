import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { BACKEND_URL } from '../config'
export default function useSocket(){ 
  const socketRef = useRef(null)
  const [spot, setSpot] = useState(24350)
  useEffect(()=>{
    const s = io(BACKEND_URL, { transports: ['websocket'] })
    socketRef.current = s
    s.on('connect', ()=> { s.emit('subscribe', { underlying:'NIFTY' }) })
    s.on('tick', (t) => { if(t?.price) setSpot(Math.round(t.price)) })
    return ()=> s.disconnect()
  },[])
  return { socket: socketRef.current, spot }
}
