// Короткий звук уведомления, синтезированный Web Audio: без файлов и без системных звуков Windows.

let ctx: AudioContext | null = null
let lastAt = 0

/** Мягкий двухтоновый сигнал: запрос на подключение — вверх, просьба об управлении — один тон пониже. */
export function playChime(kind: 'joinRequest' | 'inputRequest'): void {
  // Несколько запросов подряд не превращаются в трель.
  const now = Date.now()
  if (now - lastAt < 1500) return
  lastAt = now
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const notes = kind === 'joinRequest' ? [659.25, 987.77] : [587.33]
    const t0 = ctx.currentTime + 0.02
    notes.forEach((freq, i) => {
      const start = t0 + i * 0.14
      const osc = ctx!.createOscillator()
      const gain = ctx!.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      // Плавная атака и затухание — без щелчков.
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.16, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45)
      osc.connect(gain).connect(ctx!.destination)
      osc.start(start)
      osc.stop(start + 0.5)
    })
  } catch {
    /* звук не критичен */
  }
}
