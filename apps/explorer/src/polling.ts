/** One request batch at a time; hidden tabs sleep and refresh immediately on return. */
export function visiblePolling(work: () => Promise<void>, delay: () => number, onError: (error: unknown) => void = () => {}) {
  let stopped=false,running=false,timer:ReturnType<typeof setTimeout>|undefined;
  const tick=async()=>{
    if(stopped||running||document.hidden)return;
    running=true;
    try{await work();}catch(error){if(!stopped)onError(error);}finally{
      running=false;if(!stopped&&!document.hidden)timer=setTimeout(()=>void tick(),delay());
    }
  };
  const visibility=()=>{clearTimeout(timer);if(!document.hidden)void tick();};
  document.addEventListener('visibilitychange',visibility);void tick();
  return()=>{stopped=true;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
}
