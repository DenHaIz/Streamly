// StreamlyHelper: небольшой помощник Streamly для того, чего нет в Electron.
//  - громкость трансляции (сессия звука процесса Moonlight);
//  - курсор на другой монитор, фокус и положение окна Moonlight;
//  - маршрутизация звука хоста: Discord мимо трансляции (как «Echo Cancelling» в Parsec).
//
// Собирается компилятором C# из .NET Framework 4 (есть в каждой Windows 10/11): scripts/build-helper.mjs.
// Протокол: по строке JSON на команду в stdin, по строке JSON на ответ или событие в stdout.
// Когда stdin закрывается (Streamly завершился), помощник возвращает маршрутизацию звука и выходит.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Streamly
{
    static class Program
    {
        static readonly object OutLock = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        public static void Emit(Dictionary<string, object> msg)
        {
            string line = Json.Serialize(msg);
            lock (OutLock)
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }

        public static void Log(string text)
        {
            var m = new Dictionary<string, object>();
            m["event"] = "log";
            m["text"] = text;
            Emit(m);
        }

        [MTAThread]
        static int Main(string[] args)
        {
            Native.MakeDpiAware();
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            var router = new AudioRouter();
            var ready = new Dictionary<string, object>();
            ready["event"] = "ready";
            ready["version"] = 1;
            Emit(ready);

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim().TrimStart((char)0xFEFF);
                if (line.Length == 0) continue;
                object id = null;
                var reply = new Dictionary<string, object>();
                try
                {
                    var cmd = Json.Deserialize<Dictionary<string, object>>(line);
                    cmd.TryGetValue("id", out id);
                    reply["result"] = Handle(cmd, router);
                    reply["ok"] = true;
                }
                catch (Exception e)
                {
                    reply["ok"] = false;
                    reply["error"] = e.Message;
                }
                reply["id"] = id;
                Emit(reply);
            }
            router.Shutdown();
            return 0;
        }

        static object Handle(Dictionary<string, object> c, AudioRouter router)
        {
            string cmd = Str(c, "cmd");
            switch (cmd)
            {
                case "ping":
                    return "pong";
                case "volume":
                    return CoreAudio.SetProcessVolume(Int(c, "pid"), (float)Num(c, "level"));
                case "windowRect":
                    {
                        IntPtr h = Native.MainWindow(Int(c, "pid"));
                        if (h == IntPtr.Zero) return null;
                        Native.RECT r;
                        Native.GetWindowRect(h, out r);
                        return Rect(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
                    }
                case "focus":
                    {
                        IntPtr h = Native.MainWindow(Int(c, "pid"));
                        return h != IntPtr.Zero && Native.Activate(h);
                    }
                case "cursorToOtherScreen":
                    return CursorToOtherScreen(Int(c, "pid"));
                case "screens":
                    {
                        var list = new List<object>();
                        foreach (Screen s in Screen.AllScreens)
                        {
                            var d = Rect(s.Bounds.X, s.Bounds.Y, s.Bounds.Width, s.Bounds.Height);
                            d["name"] = s.DeviceName;
                            d["primary"] = s.Primary;
                            list.Add(d);
                        }
                        return list;
                    }
                case "devices":
                    return CoreAudio.ListRenderDevices();
                case "netInfo":
                    return NetInfo();
                case "gpus":
                    {
                        // Видеокарты ПК: чтобы заметить, что видео кодирует встроенная графика, а не дискретная.
                        var names = new List<object>();
                        using (var q = new System.Management.ManagementObjectSearcher("SELECT Name FROM Win32_VideoController"))
                        {
                            foreach (System.Management.ManagementObject o in q.Get())
                            {
                                object n = o["Name"];
                                if (n != null) names.Add(n.ToString());
                                o.Dispose();
                            }
                        }
                        return names;
                    }
                case "sendKeys":
                    {
                        // Сочетание клавиш окну процесса (например, статистика Moonlight: Ctrl+Alt+Shift+S).
                        IntPtr h = Native.MainWindow(Int(c, "pid"));
                        if (h == IntPtr.Zero || !Native.Activate(h)) return false;
                        Thread.Sleep(120);
                        return Native.SendCombo(Strings(c, "keys"));
                    }
                case "xinput":
                    // Геймпады XInput на этом ПК (у хоста — в том числе виртуальные геймпады игроков): номер слота,
                    // подключён ли и нажато ли сейчас что-нибудь (для «какой геймпад мой»).
                    return Native.XInputSlots();
                case "hung":
                    {
                        // Окно процесса не отвечает (Windows считает окно зависшим через 5 с без обработки сообщений).
                        // Видимость не проверяем: зависшее окно Windows прячет за «призраком».
                        return Native.AnyHungWindow(Int(c, "pid"));
                    }
                case "router":
                    router.Configure(Bool(c, "enabled"), Bool(c, "monitor"), Bool(c, "excludeChat"), Strings(c, "chatApps"), Strings(c, "virtualNames"));
                    return router.Snapshot();
                case "routerState":
                    return router.Snapshot();
                case "appDevice":
                    {
                        // Для диагностики: закрепить вывод процесса за устройством (пустой device — сбросить).
                        string device = Str(c, "device");
                        string err = PolicyConfig.SetAppDevice(Int(c, "pid"), device.Length > 0 ? device : null);
                        if (err != null) throw new Exception(err);
                        return true;
                    }
                default:
                    throw new ArgumentException("unknown command: " + cmd);
            }
        }

        /** Сетевые адаптеры: тип (Wi-Fi или кабель), адреса, шлюз и счётчики байт. */
        static object NetInfo()
        {
            var list = new List<object>();
            foreach (System.Net.NetworkInformation.NetworkInterface ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Loopback) continue;
                var props = ni.GetIPProperties();
                var addrs = new List<object>();
                foreach (var a in props.UnicastAddresses)
                {
                    if (a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) addrs.Add(a.Address.ToString());
                }
                bool gateway = false;
                foreach (var g in props.GatewayAddresses)
                {
                    if (g.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && !g.Address.Equals(System.Net.IPAddress.Any)) gateway = true;
                }
                var stats = ni.GetIPStatistics();
                var d = new Dictionary<string, object>();
                d["name"] = ni.Name;
                d["description"] = ni.Description;
                d["wifi"] = ni.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Wireless80211;
                d["addresses"] = addrs;
                d["gateway"] = gateway;
                d["speedMbps"] = ni.Speed > 0 ? ni.Speed / 1000000 : 0;
                d["sent"] = stats.BytesSent;
                d["received"] = stats.BytesReceived;
                list.Add(d);
            }
            return list;
        }

        /** Курсор в центр другого монитора; фокус — окну под курсором, чтобы Moonlight отпустил мышь. */
        static object CursorToOtherScreen(int pid)
        {
            Screen[] all = Screen.AllScreens;
            if (all.Length < 2) return false;
            Screen current = Screen.PrimaryScreen;
            IntPtr h = Native.MainWindow(pid);
            if (h != IntPtr.Zero)
            {
                Native.RECT r;
                Native.GetWindowRect(h, out r);
                current = Screen.FromRectangle(new Rectangle(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top));
            }
            Screen target = null;
            foreach (Screen s in all)
            {
                if (s.DeviceName == current.DeviceName) continue;
                if (target == null || s.Primary) target = s;
            }
            if (target == null) return false;
            int x = target.Bounds.X + target.Bounds.Width / 2;
            int y = target.Bounds.Y + target.Bounds.Height / 2;
            Native.SetCursorPos(x, y);
            IntPtr under = Native.WindowUnder(x, y);
            if (under == IntPtr.Zero || Native.ProcessOf(under) == pid) under = Native.GetShellWindow();
            if (under != IntPtr.Zero) Native.Activate(under);
            return true;
        }

        static Dictionary<string, object> Rect(int x, int y, int w, int h)
        {
            var d = new Dictionary<string, object>();
            d["x"] = x;
            d["y"] = y;
            d["width"] = w;
            d["height"] = h;
            return d;
        }

        static string Str(Dictionary<string, object> c, string k)
        {
            object v;
            return c.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : "";
        }

        static int Int(Dictionary<string, object> c, string k)
        {
            object v;
            if (!c.TryGetValue(k, out v) || v == null) throw new ArgumentException("missing " + k);
            return Convert.ToInt32(v);
        }

        static double Num(Dictionary<string, object> c, string k)
        {
            object v;
            if (!c.TryGetValue(k, out v) || v == null) throw new ArgumentException("missing " + k);
            return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture);
        }

        static bool Bool(Dictionary<string, object> c, string k)
        {
            object v;
            return c.TryGetValue(k, out v) && v is bool && (bool)v;
        }

        static string[] Strings(Dictionary<string, object> c, string k)
        {
            object v;
            var list = new List<string>();
            if (c.TryGetValue(k, out v) && v is System.Collections.ArrayList)
            {
                foreach (object o in (System.Collections.ArrayList)v)
                {
                    if (o is string) list.Add((string)o);
                }
            }
            return list.ToArray();
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Маршрутизация звука хоста.
    //
    // Apollo захватывает звук целиком с одного устройства. Чтобы друзья не слышали в трансляции
    // голосовой чат (и собственный голос), Streamly просит Moonlight не оставлять звук на хосте:
    // Apollo делает устройством по умолчанию виртуальные колонки (Steam Streaming Speakers) и
    // захватывает их. Помощник в это время:
    //  - закрепляет Discord за настоящими колонками хоста (настройка Windows «звук приложения»),
    //    поэтому Discord не попадает в трансляцию, а хост его слышит;
    //  - повторяет звук виртуальных колонок на настоящие (monitor), чтобы хост слышал игру.
    // Когда трансляция заканчивается, Apollo возвращает устройство по умолчанию, помощник снимает
    // закрепление Discord и останавливает повтор.
    // ---------------------------------------------------------------------------------------------
    sealed class AudioRouter
    {
        readonly object sync = new object();
        bool enabled, monitor, excludeChat;
        string[] chatApps = new string[0];
        string[] virtualNames = new string[0];
        Thread thread;
        volatile bool stopping;

        string physicalId, virtualId, lastError;
        bool active, monitoring;
        readonly Dictionary<int, bool> routedPids = new Dictionary<int, bool>();
        LoopbackBridge bridge;
        string lastSnapshot = "";
        DateTime nextDeviceScan = DateTime.MinValue;
        DateTime nextProcessScan = DateTime.MinValue;

        public void Configure(bool enabled, bool monitor, bool excludeChat, string[] chatApps, string[] virtualNames)
        {
            lock (sync)
            {
                this.enabled = enabled;
                this.monitor = monitor;
                this.excludeChat = excludeChat;
                this.chatApps = chatApps;
                if (virtualNames.Length > 0) this.virtualNames = virtualNames;
                // Сразу ищем виртуальные колонки, чтобы ответ на команду уже говорил, доступна ли маршрутизация.
                try
                {
                    virtualId = CoreAudio.FindRenderDevice(this.virtualNames);
                }
                catch (Exception e)
                {
                    lastError = e.Message;
                }
                nextDeviceScan = DateTime.UtcNow.AddSeconds(5);
                nextProcessScan = DateTime.MinValue;
                if (thread == null)
                {
                    // Закрепления от прошлого запуска (если Streamly упал) больше не нужны.
                    ClearChatRouting(true);
                    thread = new Thread(Loop);
                    thread.IsBackground = true;
                    thread.Start();
                }
            }
        }

        public Dictionary<string, object> Snapshot()
        {
            lock (sync)
            {
                var d = new Dictionary<string, object>();
                d["enabled"] = enabled;
                d["virtualFound"] = virtualId != null;
                d["virtualName"] = virtualId != null ? CoreAudio.FriendlyName(virtualId) : null;
                d["active"] = active;
                d["monitoring"] = monitoring;
                d["chatExcluded"] = routedPids.Count > 0;
                d["error"] = lastError;
                return d;
            }
        }

        void Loop()
        {
            while (!stopping)
            {
                try
                {
                    Tick();
                }
                catch (Exception e)
                {
                    lock (sync) lastError = e.Message;
                }
                PublishIfChanged();
                Thread.Sleep(400);
            }
        }

        void Tick()
        {
            bool en, mon, ex;
            lock (sync)
            {
                en = enabled;
                mon = monitor;
                ex = excludeChat;
            }
            if (DateTime.UtcNow >= nextDeviceScan)
            {
                string found = CoreAudio.FindRenderDevice(virtualNames);
                lock (sync) virtualId = found;
                nextDeviceScan = DateTime.UtcNow.AddSeconds(5);
            }
            string def = CoreAudio.DefaultRenderId();
            bool isVirtual = def != null && def == virtualId;
            if (def != null && !isVirtual) physicalId = def;
            if (isVirtual && physicalId == null) physicalId = CoreAudio.FirstRenderDeviceExcept(virtualId);

            bool nowActive = en && isVirtual && physicalId != null;
            lock (sync) active = nowActive;

            // Повтор виртуальных колонок на настоящие.
            bool wantMonitor = nowActive && mon;
            if (wantMonitor && (bridge == null || bridge.Finished || bridge.Source != virtualId || bridge.Target != physicalId))
            {
                if (bridge != null) bridge.Stop();
                bridge = new LoopbackBridge(virtualId, physicalId);
                bridge.Start();
            }
            else if (!wantMonitor && bridge != null)
            {
                bridge.Stop();
                bridge = null;
            }
            lock (sync)
            {
                monitoring = bridge != null && !bridge.Finished;
                if (bridge != null && bridge.Error != null) lastError = bridge.Error;
            }

            // Голосовой чат мимо трансляции.
            bool wantRoute = nowActive && ex;
            if (wantRoute)
            {
                if (DateTime.UtcNow >= nextProcessScan)
                {
                    RouteChat(physicalId);
                    nextProcessScan = DateTime.UtcNow.AddSeconds(2);
                }
            }
            else if (routedPids.Count > 0)
            {
                ClearChatRouting(false);
            }
        }

        void RouteChat(string deviceId)
        {
            foreach (int pid in ChatPids())
            {
                if (routedPids.ContainsKey(pid)) continue;
                string err = PolicyConfig.SetAppDevice(pid, deviceId);
                lock (sync)
                {
                    if (err == null) routedPids[pid] = true;
                    else lastError = err;
                }
            }
        }

        void ClearChatRouting(bool all)
        {
            var pids = new List<int>(routedPids.Keys);
            if (all) pids.AddRange(ChatPids());
            foreach (int pid in pids) PolicyConfig.SetAppDevice(pid, null);
            lock (sync) routedPids.Clear();
        }

        IEnumerable<int> ChatPids()
        {
            var list = new List<int>();
            foreach (string name in chatApps)
            {
                foreach (Process p in Process.GetProcessesByName(name))
                {
                    list.Add(p.Id);
                    p.Dispose();
                }
            }
            return list;
        }

        void PublishIfChanged()
        {
            var snap = Snapshot();
            string text = new JavaScriptSerializer().Serialize(snap);
            if (text == lastSnapshot) return;
            lastSnapshot = text;
            var m = new Dictionary<string, object>();
            m["event"] = "router";
            m["state"] = snap;
            Program.Emit(m);
        }

        public void Shutdown()
        {
            stopping = true;
            if (thread != null) thread.Join(2000);
            if (bridge != null) bridge.Stop();
            try
            {
                ClearChatRouting(false);
            }
            catch
            {
            }
        }
    }

    /** Повтор звука одного устройства (loopback) на другое с небольшой задержкой. */
    sealed class LoopbackBridge
    {
        public readonly string Source, Target;
        public volatile bool Finished;
        public volatile string Error;
        volatile bool stop;
        Thread thread;

        public LoopbackBridge(string source, string target)
        {
            Source = source;
            Target = target;
        }

        public void Start()
        {
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Priority = ThreadPriority.AboveNormal;
            thread.Start();
        }

        public void Stop()
        {
            stop = true;
            if (thread != null) thread.Join(1500);
        }

        void Run()
        {
            IAudioClient cap = null, ren = null;
            IAudioCaptureClient capture = null;
            IAudioRenderClient render = null;
            IntPtr format = IntPtr.Zero;
            try
            {
                cap = CoreAudio.ActivateClient(Source);
                ren = CoreAudio.ActivateClient(Target);
                Check(cap.GetMixFormat(out format), "GetMixFormat");
                int channels = Marshal.ReadInt16(format, 2);
                int rate = Marshal.ReadInt32(format, 4);
                int block = Marshal.ReadInt16(format, 12);
                Check(cap.Initialize(0, CoreAudio.AUDCLNT_STREAMFLAGS_LOOPBACK, 1000000, 0, format, IntPtr.Zero), "capture Initialize");
                Check(ren.Initialize(0, CoreAudio.AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | CoreAudio.AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 500000, 0, format, IntPtr.Zero), "render Initialize");
                object o;
                Guid iidCap = typeof(IAudioCaptureClient).GUID, iidRen = typeof(IAudioRenderClient).GUID;
                Check(cap.GetService(ref iidCap, out o), "capture service");
                capture = (IAudioCaptureClient)o;
                Check(ren.GetService(ref iidRen, out o), "render service");
                render = (IAudioRenderClient)o;
                uint renFrames;
                Check(ren.GetBufferSize(out renFrames), "GetBufferSize");

                // Кольцевой буфер на секунду. Держим около 30 мс: меньше — щелчки, больше — заметная задержка.
                var ring = new ByteRing(rate * block);
                int target = rate * 30 / 1000;
                int maxQueued = rate * 90 / 1000;
                var tmp = new byte[rate * block / 5];
                Check(cap.Start(), "capture Start");
                Check(ren.Start(), "render Start");
                Program.Log("monitor started: " + channels + "ch " + rate + "Hz");

                while (!stop)
                {
                    Thread.Sleep(3);
                    uint packet;
                    while (true)
                    {
                        Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
                        if (packet == 0) break;
                        IntPtr data;
                        uint frames, flags;
                        ulong pos, qpc;
                        Check(capture.GetBuffer(out data, out frames, out flags, out pos, out qpc), "capture GetBuffer");
                        int bytes = (int)frames * block;
                        if (bytes > tmp.Length) tmp = new byte[bytes];
                        if ((flags & 2) != 0) Array.Clear(tmp, 0, bytes);
                        else Marshal.Copy(data, tmp, 0, bytes);
                        capture.ReleaseBuffer(frames);
                        ring.Write(tmp, bytes);
                    }
                    // Часы виртуальных и настоящих колонок немного расходятся: лишнее выбрасываем.
                    if (ring.Count / block > maxQueued) ring.Skip(ring.Count - target * block);

                    uint padding;
                    Check(ren.GetCurrentPadding(out padding), "GetCurrentPadding");
                    int room = Math.Min((int)(renFrames - padding), Math.Max(0, target - (int)padding + rate / 100));
                    int frameCount = Math.Min(room, ring.Count / block);
                    if (frameCount <= 0) continue;
                    IntPtr dst;
                    Check(render.GetBuffer((uint)frameCount, out dst), "render GetBuffer");
                    int n = frameCount * block;
                    if (n > tmp.Length) tmp = new byte[n];
                    ring.Read(tmp, n);
                    Marshal.Copy(tmp, 0, dst, n);
                    render.ReleaseBuffer((uint)frameCount, 0);
                }
            }
            catch (Exception e)
            {
                Error = "monitor: " + e.Message;
                Program.Log(Error);
            }
            finally
            {
                try
                {
                    if (cap != null) cap.Stop();
                    if (ren != null) ren.Stop();
                }
                catch
                {
                }
                if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
                Release(capture);
                Release(render);
                Release(cap);
                Release(ren);
                Finished = true;
            }
        }

        static void Check(int hr, string what)
        {
            if (hr < 0) throw new Exception(what + " 0x" + hr.ToString("X8"));
        }

        static void Release(object o)
        {
            if (o != null) Marshal.ReleaseComObject(o);
        }
    }

    sealed class ByteRing
    {
        readonly byte[] buf;
        int head, count;

        public ByteRing(int size)
        {
            buf = new byte[size];
        }

        public int Count
        {
            get { return count; }
        }

        public void Write(byte[] src, int n)
        {
            if (n > buf.Length)
            {
                Skip(count);
                n = buf.Length;
            }
            if (count + n > buf.Length) Skip(count + n - buf.Length);
            int tail = (head + count) % buf.Length;
            int first = Math.Min(n, buf.Length - tail);
            Buffer.BlockCopy(src, 0, buf, tail, first);
            Buffer.BlockCopy(src, first, buf, 0, n - first);
            count += n;
        }

        public void Read(byte[] dst, int n)
        {
            int first = Math.Min(n, buf.Length - head);
            Buffer.BlockCopy(buf, head, dst, 0, first);
            Buffer.BlockCopy(buf, 0, dst, first, n - first);
            Skip(n);
        }

        public void Skip(int n)
        {
            n = Math.Min(n, count);
            head = (head + n) % buf.Length;
            count -= n;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Устройство вывода для отдельного приложения (как «Параметры звука → Громкость приложений»).
    // Внутренний интерфейс Windows, тот же, что использует EarTrumpet.
    // ---------------------------------------------------------------------------------------------
    static class PolicyConfig
    {
        [DllImport("combase.dll", PreserveSig = true)]
        static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

        [DllImport("combase.dll", PreserveSig = true)]
        static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string s, int length, out IntPtr hstring);

        [DllImport("combase.dll", PreserveSig = true)]
        static extern int WindowsDeleteString(IntPtr hstring);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        delegate int SetPersistedFn(IntPtr self, uint pid, int flow, int role, IntPtr deviceId);

        static IntPtr factory = IntPtr.Zero;

        static readonly Guid[] Iids =
        {
            new Guid("ab3d4648-e242-459f-b02f-541c70306324"), // Windows 10 21H2 и новее
            new Guid("2a59116d-6c4f-45e0-a74f-707e3fef9258")  // более ранние
        };

        static IntPtr Factory()
        {
            if (factory != IntPtr.Zero) return factory;
            IntPtr name;
            const string cls = "Windows.Media.Internal.AudioPolicyConfig";
            int hr = WindowsCreateString(cls, cls.Length, out name);
            if (hr < 0) throw new Exception("WindowsCreateString 0x" + hr.ToString("X8"));
            try
            {
                foreach (Guid g in Iids)
                {
                    Guid iid = g;
                    IntPtr f;
                    if (RoGetActivationFactory(name, ref iid, out f) >= 0 && f != IntPtr.Zero)
                    {
                        factory = f;
                        return f;
                    }
                }
            }
            finally
            {
                WindowsDeleteString(name);
            }
            throw new Exception("AudioPolicyConfig is not available");
        }

        /** Закрепляет вывод приложения за устройством (null — снова «по умолчанию»). Возвращает текст ошибки или null. */
        public static string SetAppDevice(int pid, string mmDeviceId)
        {
            try
            {
                IntPtr f = Factory();
                // IUnknown (3) + IInspectable (3) + 19 других методов: SetPersistedDefaultAudioEndpoint — 26-й в таблице.
                IntPtr vtbl = Marshal.ReadIntPtr(f);
                var set = (SetPersistedFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, 25 * IntPtr.Size), typeof(SetPersistedFn));
                IntPtr hs = IntPtr.Zero;
                if (mmDeviceId != null)
                {
                    string full = @"\\?\SWD#MMDEVAPI#" + mmDeviceId + "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
                    WindowsCreateString(full, full.Length, out hs);
                }
                try
                {
                    // eRender; роли eConsole и eMultimedia (так делает и окно настроек Windows).
                    int hr1 = set(f, (uint)pid, 0, 0, hs);
                    int hr2 = set(f, (uint)pid, 0, 1, hs);
                    if (hr1 < 0 || hr2 < 0) return "SetPersistedDefaultAudioEndpoint 0x" + Math.Min(hr1, hr2).ToString("X8");
                }
                finally
                {
                    if (hs != IntPtr.Zero) WindowsDeleteString(hs);
                }
                return null;
            }
            catch (Exception e)
            {
                return e.Message;
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Core Audio (MMDevice API, WASAPI).
    // ---------------------------------------------------------------------------------------------
    static class CoreAudio
    {
        public const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        public const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
        public const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        const int DEVICE_STATE_ACTIVE = 1;
        const int CLSCTX_ALL = 23;

        static IMMDeviceEnumerator Enumerator()
        {
            return (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        }

        static string Id(IMMDevice d)
        {
            string id;
            return d.GetId(out id) >= 0 ? id : null;
        }

        static List<IMMDevice> ActiveRender(IMMDeviceEnumerator en)
        {
            var list = new List<IMMDevice>();
            IMMDeviceCollection col;
            if (en.EnumAudioEndpoints(0, DEVICE_STATE_ACTIVE, out col) < 0) return list;
            int n;
            col.GetCount(out n);
            for (int i = 0; i < n; i++)
            {
                IMMDevice d;
                if (col.Item(i, out d) >= 0) list.Add(d);
            }
            Marshal.ReleaseComObject(col);
            return list;
        }

        public static string FriendlyName(string id)
        {
            var en = Enumerator();
            IMMDevice d;
            if (en.GetDevice(id, out d) < 0) return null;
            string name = FriendlyName(d);
            Marshal.ReleaseComObject(d);
            return name;
        }

        static string FriendlyName(IMMDevice d)
        {
            IPropertyStore props;
            if (d.OpenPropertyStore(0, out props) < 0) return null;
            try
            {
                var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
                PROPVARIANT v;
                if (props.GetValue(ref key, out v) < 0) return null;
                string s = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : null;
                PropVariantClear(ref v);
                return s;
            }
            finally
            {
                Marshal.ReleaseComObject(props);
            }
        }

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PROPVARIANT pvar);

        public static List<object> ListRenderDevices()
        {
            var en = Enumerator();
            string def = DefaultRenderId();
            var list = new List<object>();
            foreach (IMMDevice d in ActiveRender(en))
            {
                var m = new Dictionary<string, object>();
                m["id"] = Id(d);
                m["name"] = FriendlyName(d);
                m["default"] = Id(d) == def;
                list.Add(m);
                Marshal.ReleaseComObject(d);
            }
            return list;
        }

        public static string DefaultRenderId()
        {
            var en = Enumerator();
            IMMDevice d;
            if (en.GetDefaultAudioEndpoint(0, 1, out d) < 0 || d == null) return null;
            string id = Id(d);
            Marshal.ReleaseComObject(d);
            return id;
        }

        /** Активное устройство вывода, имя которого содержит одну из строк. */
        public static string FindRenderDevice(string[] names)
        {
            var en = Enumerator();
            string found = null;
            foreach (IMMDevice d in ActiveRender(en))
            {
                string name = FriendlyName(d) ?? "";
                if (found == null)
                {
                    foreach (string n in names)
                    {
                        if (n.Length > 0 && name.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            found = Id(d);
                            break;
                        }
                    }
                }
                Marshal.ReleaseComObject(d);
            }
            return found;
        }

        public static string FirstRenderDeviceExcept(string except)
        {
            var en = Enumerator();
            string found = null;
            foreach (IMMDevice d in ActiveRender(en))
            {
                string id = Id(d);
                if (found == null && id != except) found = id;
                Marshal.ReleaseComObject(d);
            }
            return found;
        }

        public static IAudioClient ActivateClient(string id)
        {
            var en = Enumerator();
            IMMDevice d;
            int hr = en.GetDevice(id, out d);
            if (hr < 0) throw new Exception("GetDevice 0x" + hr.ToString("X8"));
            try
            {
                Guid iid = typeof(IAudioClient).GUID;
                object o;
                hr = d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
                if (hr < 0) throw new Exception("Activate 0x" + hr.ToString("X8"));
                return (IAudioClient)o;
            }
            finally
            {
                Marshal.ReleaseComObject(d);
            }
        }

        /** Громкость всех звуковых сессий процесса на всех устройствах. Возвращает число найденных сессий. */
        public static int SetProcessVolume(int pid, float level)
        {
            level = Math.Max(0f, Math.Min(1f, level));
            var en = Enumerator();
            int found = 0;
            Guid ctx = Guid.Empty;
            foreach (IMMDevice d in ActiveRender(en))
            {
                try
                {
                    Guid iid = typeof(IAudioSessionManager2).GUID;
                    object o;
                    if (d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) < 0) continue;
                    var mgr = (IAudioSessionManager2)o;
                    IAudioSessionEnumerator sessions;
                    if (mgr.GetSessionEnumerator(out sessions) >= 0)
                    {
                        int n;
                        sessions.GetCount(out n);
                        for (int i = 0; i < n; i++)
                        {
                            object so;
                            if (sessions.GetSession(i, out so) < 0) continue;
                            var ctl = (IAudioSessionControl2)so;
                            uint sp;
                            if (ctl.GetProcessId(out sp) >= 0 && sp == (uint)pid)
                            {
                                var vol = (ISimpleAudioVolume)so;
                                vol.SetMasterVolume(level, ref ctx);
                                found++;
                            }
                            Marshal.ReleaseComObject(so);
                        }
                        Marshal.ReleaseComObject(sessions);
                    }
                    Marshal.ReleaseComObject(mgr);
                }
                finally
                {
                    Marshal.ReleaseComObject(d);
                }
            }
            return found;
        }
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject
    {
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT
    {
        public ushort vt;
        public ushort r1, r2, r3;
        public IntPtr p;
        public IntPtr p2;
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioRenderClient
    {
        [PreserveSig] int GetBuffer(uint frames, out IntPtr data);
        [PreserveSig] int ReleaseBuffer(uint frames, uint flags);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
        [PreserveSig] int RegisterSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
        [PreserveSig] int RegisterDuckNotification(IntPtr sessionId, IntPtr notification);
        [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, IntPtr ctx);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, IntPtr ctx);
        [PreserveSig] int GetGroupingParam(out Guid grouping);
        [PreserveSig] int SetGroupingParam(IntPtr grouping, IntPtr ctx);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute(int mute, ref Guid ctx);
        [PreserveSig] int GetMute(out int mute);
    }

    // ---------------------------------------------------------------------------------------------
    // Окна и курсор.
    // ---------------------------------------------------------------------------------------------
    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X, Y;
        }

        delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);

        [StructLayout(LayoutKind.Sequential)]
        struct XINPUT_STATE
        {
            public uint dwPacketNumber;
            public ushort wButtons;
            public byte bLeftTrigger;
            public byte bRightTrigger;
            public short sThumbLX, sThumbLY, sThumbRX, sThumbRY;
        }

        [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")] static extern uint XInputGetState14(uint index, out XINPUT_STATE state);
        [DllImport("xinput9_1_0.dll", EntryPoint = "XInputGetState")] static extern uint XInputGetState910(uint index, out XINPUT_STATE state);
        static bool? xinput14;

        static uint GetState(uint i, out XINPUT_STATE st)
        {
            if (xinput14 != false)
            {
                try
                {
                    uint r = XInputGetState14(i, out st);
                    xinput14 = true;
                    return r;
                }
                catch (DllNotFoundException)
                {
                    xinput14 = false;
                }
            }
            return XInputGetState910(i, out st);
        }

        static bool Moved(short v)
        {
            return v > 16000 || v < -16000;
        }

        /** Четыре слота XInput: подключён ли геймпад, номер пакета и нажато ли что-нибудь. */
        public static List<object> XInputSlots()
        {
            var list = new List<object>();
            for (uint i = 0; i < 4; i++)
            {
                XINPUT_STATE st;
                bool on = GetState(i, out st) == 0;
                bool active = on && (st.wButtons != 0 || st.bLeftTrigger > 60 || st.bRightTrigger > 60 || Moved(st.sThumbLX) || Moved(st.sThumbLY) || Moved(st.sThumbRX) || Moved(st.sThumbRY));
                var d = new Dictionary<string, object>();
                d["index"] = (int)i;
                d["connected"] = on;
                d["packet"] = on ? (double)st.dwPacketNumber : 0.0;
                d["active"] = active;
                list.Add(d);
            }
            return list;
        }

        public static void MakeDpiAware()
        {
            try
            {
                // PER_MONITOR_AWARE_V2: координаты окон, мониторов и курсора в настоящих пикселях.
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch (EntryPointNotFoundException)
            {
            }
            SetProcessDPIAware();
        }

        /** Самое большое видимое окно процесса. */
        public static IntPtr MainWindow(int pid)
        {
            IntPtr best = IntPtr.Zero;
            long bestArea = 0;
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                uint p;
                GetWindowThreadProcessId(h, out p);
                if (p != (uint)pid || !IsWindowVisible(h)) return true;
                RECT r;
                GetWindowRect(h, out r);
                long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
                if (area > bestArea)
                {
                    bestArea = area;
                    best = h;
                }
                return true;
            }, IntPtr.Zero);
            return best;
        }

        /** Есть ли у процесса окно, которое Windows считает зависшим (видимое или нет). */
        public static bool AnyHungWindow(int pid)
        {
            bool hung = false;
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                uint p;
                GetWindowThreadProcessId(h, out p);
                if (p == (uint)pid && IsHungAppWindow(h))
                {
                    hung = true;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return hung;
        }

        public static int ProcessOf(IntPtr h)
        {
            uint p;
            GetWindowThreadProcessId(h, out p);
            return (int)p;
        }

        public static IntPtr WindowUnder(int x, int y)
        {
            var pt = new POINT { X = x, Y = y };
            IntPtr h = WindowFromPoint(pt);
            return h == IntPtr.Zero ? h : GetAncestor(h, 2);
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        // INPUT для клавиатуры; union дополнен до размера MOUSEINPUT (32 байта на x64).
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT
        {
            public uint type;
            public KEYBDINPUT ki;
            public uint pad1, pad2;
        }

        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

        static ushort Vk(string key)
        {
            switch (key.ToLowerInvariant())
            {
                case "ctrl": return 0x11;
                case "alt": return 0x12;
                case "shift": return 0x10;
                default:
                    if (key.Length == 1) return (ushort)char.ToUpperInvariant(key[0]);
                    throw new ArgumentException("unknown key " + key);
            }
        }

        /** Нажимает клавиши по порядку и отпускает в обратном (как сочетание). */
        public static bool SendCombo(string[] keys)
        {
            if (keys.Length == 0) return false;
            var inputs = new List<INPUT>();
            foreach (string k in keys) inputs.Add(new INPUT { type = 1, ki = new KEYBDINPUT { wVk = Vk(k) } });
            for (int i = keys.Length - 1; i >= 0; i--) inputs.Add(new INPUT { type = 1, ki = new KEYBDINPUT { wVk = Vk(keys[i]), dwFlags = 2 } });
            INPUT[] arr = inputs.ToArray();
            return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))) == arr.Length;
        }

        /** Делает окно активным. Если Windows запрещает (окно другого процесса), подключаемся к его потоку ввода. */
        public static bool Activate(IntPtr h)
        {
            if (SetForegroundWindow(h)) return true;
            uint dummy;
            uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
            uint me = GetCurrentThreadId();
            bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
            BringWindowToTop(h);
            bool ok = SetForegroundWindow(h);
            if (attached) AttachThreadInput(me, fg, false);
            return ok;
        }
    }
}
