// W1 GPU 预览管线（2026-11-18）。
// 选型：D3DImage（WPF 自带，PresentationCore.dll，build.ps1 的 csc 引用里已有）
//   + Direct3D9Ex（P/Invoke 直调 d3d9.dll 的 Direct3DCreate9Ex，不用 SharpDX/SlimDX——
//   build.ps1 是裸 csc 编译、没有 NuGet，那两个库不在引用里，假设它们存在是错的）。
// 做法：FFmpeg 解出的 BGRA 帧直接拷进 D3D9 动态纹理；静态铬层（背景、阴影、窗框、标题栏、描边，
//   见 StudioRenderer.RenderChrome）只在播放开始时用 GDI+ 烤一次成纹理；每帧 GPU 只画两个纹理四边形
//   （视频 + 铬层，硬件双线性缩放），再经 D3DImage 交给 WPF 合成。播放热路径上不再有 GDI+ 全场景重绘，
//   也不再每帧 new BitmapSource + 换 preview.Source。
// 降级（按顺序，全部静默、绝不让启动检查挂掉）：
//   (1) D3D 设备建不起来（云端 windows-2025 runner 没有真 GPU 时就走这条）→ WriteableBitmap 软件路径；
//   (2) 文档含贴图/柔化/聚光、光标、开场、屏幕 3D（GPU 四边形画不出的时间相关内容）→ 仍用 GDI+ Compose
//       逐帧合成，但合成好的帧仍经 D3D 纹理上传呈现（或 WriteableBitmap），不再走 BitmapSource.Create；
//   (3) 播放中设备丢失/调用失败 → 当场切回软件路径继续播，不抛、不卡死。
// 限制（如实写，不吹）：这只是预览管线，导出仍走 GDI+ 的 StudioRenderer.Export；
//   GPU 合成是双线性缩放，不是 GDI+ 的 HighQualityBicubic，暂停逐帧检查仍用原 Compose；
//   本机 Linux 跑不了 WPF，验证全靠云端 windows-2025 构建 + --snapshot 启动检查；
//   他电脑是 RTX 4060 Ti，硬件路径在他那要走通（云端 runner 只能证明编译 + 降级不挂）。
//   另：RenderTargetBitmap 抓不到 D3DImage 的内容，所以 --snapshot 产出的 editor-preview.png 里预览区
//   在走硬件路径时可能是空白——文件照常产出、启动检查只认文件存在；真实窗口里的预览是正常的。
using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using D = System.Drawing;

namespace DogSC.Replica {
 static class GpuPreviewNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetDesktopWindow();
 }

 // Direct3D9 COM 直调：只用虚表序号调真正用到的几个方法，不声明整张虚表。
 // 序号依据 d3d9.h：IDirect3D9Ex::CreateDeviceEx=14；IDirect3DDevice9::CreateTexture=23、
 // SetRenderTarget=37、BeginScene=41、EndScene=42、Clear=43、SetViewport=47、SetRenderState=57、
 // SetTexture=65、SetTextureStageState=67、SetSamplerState=69、DrawPrimitiveUP=83、SetFVF=89；
 // IDirect3DTexture9::GetSurfaceLevel=16、LockRect=17、UnlockRect=18。
 static class D3D9 {
  public const uint SDK_VERSION = 32;
  public const int DEVTYPE_HAL = 1;
  public const uint CREATE_HARDWARE_VERTEXPROCESSING = 0x40;
  public const uint CREATE_SOFTWARE_VERTEXPROCESSING = 0x20;
  public const uint CREATE_MULTITHREADED = 0x04;
  public const uint CREATE_FPU_PRESERVE = 0x02;
  public const uint FMT_A8R8G8B8 = 21;
  public const uint POOL_DEFAULT = 0;
  public const uint USAGE_RENDERTARGET = 0x1;
  public const uint USAGE_DYNAMIC = 0x200;
  public const uint LOCK_DISCARD = 0x2000;
  public const uint SWAPEFFECT_DISCARD = 1;
  public const uint CLEAR_TARGET = 1;
  public const uint PT_TRIANGLESTRIP = 5;
  public const uint FVF_XYZRHW_DIFFUSE_TEX1 = 0x004 | 0x040 | 0x100;
  public const uint RS_ZENABLE = 7;
  public const uint RS_ALPHABLENDENABLE = 27;
  public const uint RS_SRCBLEND = 19;
  public const uint RS_DESTBLEND = 20;
  public const uint RS_LIGHTING = 137;
  public const uint RS_CULLMODE = 22;
  public const uint RS_ALPHATESTENABLE = 15;
  public const uint BLEND_SRCALPHA = 5;
  public const uint BLEND_INVSRCALPHA = 6;
  public const uint CULL_NONE = 1;
  public const uint TSS_COLOROP = 1;
  public const uint TSS_COLORARG1 = 2;
  public const uint TSS_ALPHAOP = 4;
  public const uint TSS_ALPHAARG1 = 5;
  public const uint TSS_ALPHAARG2 = 6;
  public const uint TOP_SELECTARG1 = 2;
  public const uint TOP_MODULATE = 4;
  public const uint TA_TEXTURE = 2;
  public const uint TA_DIFFUSE = 0;
  public const uint SAMP_MAGFILTER = 5;
  public const uint SAMP_MINFILTER = 4;
  public const uint SAMP_MIPFILTER = 6;
  public const uint SAMP_ADDRESSU = 1;
  public const uint SAMP_ADDRESSV = 2;
  public const uint TEXF_LINEAR = 2;
  public const uint TEXF_NONE = 1;
  public const uint ADDRESS_CLAMP = 3;

  [StructLayout(LayoutKind.Sequential)]
  public struct PresentParameters {
   public uint BackBufferWidth, BackBufferHeight, BackBufferFormat, BackBufferCount;
   public uint MultiSampleType, MultiSampleQuality, SwapEffect;
   public IntPtr hDeviceWindow;
   [MarshalAs(UnmanagedType.Bool)] public bool Windowed;
   [MarshalAs(UnmanagedType.Bool)] public bool EnableAutoDepthStencil;
   public uint AutoDepthStencilFormat, Flags, FullScreen_RefreshRateInHz, PresentationInterval;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct Viewport { public uint X, Y, Width, Height; public float MinZ, MaxZ; }
  [StructLayout(LayoutKind.Sequential)]
  public struct LockedRect { public int Pitch; public IntPtr pBits; }
  [StructLayout(LayoutKind.Sequential)]
  public struct Vertex { public float X, Y, Z, Rhw; public uint Color; public float U, V; }

  [DllImport("d3d9.dll", PreserveSig = true)]
  public static extern int Direct3DCreate9Ex(uint sdkVersion, out IntPtr d3d);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int ReleaseDelegate(IntPtr self);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int CreateDeviceExDelegate(IntPtr self, uint adapter, int deviceType, IntPtr focusWindow, uint behaviorFlags, ref PresentParameters pp, IntPtr fullscreenDisplayMode, out IntPtr device);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int CreateTextureDelegate(IntPtr self, uint width, uint height, uint levels, uint usage, uint format, uint pool, out IntPtr texture, IntPtr sharedHandle);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int GetSurfaceLevelDelegate(IntPtr self, uint level, out IntPtr surface);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int LockRectDelegate(IntPtr self, uint level, out LockedRect locked, IntPtr rect, uint flags);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int UnlockRectDelegate(IntPtr self, uint level);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int SetRenderTargetDelegate(IntPtr self, uint index, IntPtr surface);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int BeginSceneDelegate(IntPtr self);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int EndSceneDelegate(IntPtr self);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int ClearDelegate(IntPtr self, uint count, IntPtr rects, uint flags, uint color, float z, uint stencil);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int SetViewportDelegate(IntPtr self, ref Viewport vp);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int SetRenderStateDelegate(IntPtr self, uint state, uint value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int SetTextureDelegate(IntPtr self, uint stage, IntPtr texture);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int SetTextureStageStateDelegate(IntPtr self, uint stage, uint type, uint value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int SetSamplerStateDelegate(IntPtr self, uint sampler, uint type, uint value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int SetFvfDelegate(IntPtr self, uint fvf);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int DrawPrimitiveUpDelegate(IntPtr self, uint primitiveType, uint primitiveCount, IntPtr vertexData, uint vertexStride);

  public static T Fn<T>(IntPtr obj, int index) {
   IntPtr vt = Marshal.ReadIntPtr(obj);
   IntPtr fp = Marshal.ReadIntPtr(vt, index * IntPtr.Size);
   return (T)(object)Marshal.GetDelegateForFunctionPointer(fp, typeof(T));
  }
  public static void Release(ref IntPtr obj) {
   if (obj == IntPtr.Zero) return;
   try { Fn<ReleaseDelegate>(obj, 2)(obj); } catch { }
   obj = IntPtr.Zero;
  }
  public static int CreateDeviceEx(IntPtr d3d, uint adapter, int deviceType, IntPtr focusWindow, uint behaviorFlags, ref PresentParameters pp, out IntPtr device) {
   return Fn<CreateDeviceExDelegate>(d3d, 14)(d3d, adapter, deviceType, focusWindow, behaviorFlags, ref pp, IntPtr.Zero, out device);
  }
  public static int CreateTexture(IntPtr device, uint w, uint h, uint levels, uint usage, uint format, uint pool, out IntPtr texture) {
   return Fn<CreateTextureDelegate>(device, 23)(device, w, h, levels, usage, format, pool, out texture, IntPtr.Zero);
  }
  public static int GetSurfaceLevel(IntPtr texture, uint level, out IntPtr surface) {
   return Fn<GetSurfaceLevelDelegate>(texture, 16)(texture, level, out surface);
  }
  public static int LockRect(IntPtr texture, uint level, out LockedRect locked, uint flags) {
   return Fn<LockRectDelegate>(texture, 17)(texture, level, out locked, IntPtr.Zero, flags);
  }
  public static int UnlockRect(IntPtr texture, uint level) {
   return Fn<UnlockRectDelegate>(texture, 18)(texture, level);
  }
  public static int SetRenderTarget(IntPtr device, uint index, IntPtr surface) {
   return Fn<SetRenderTargetDelegate>(device, 37)(device, index, surface);
  }
  public static int BeginScene(IntPtr device) { return Fn<BeginSceneDelegate>(device, 41)(device); }
  public static int EndScene(IntPtr device) { return Fn<EndSceneDelegate>(device, 42)(device); }
  public static int Clear(IntPtr device, uint flags, uint color) {
   return Fn<ClearDelegate>(device, 43)(device, 0, IntPtr.Zero, flags, color, 1.0f, 0);
  }
  public static int SetViewport(IntPtr device, ref Viewport vp) { return Fn<SetViewportDelegate>(device, 47)(device, ref vp); }
  public static int SetRenderState(IntPtr device, uint state, uint value) { return Fn<SetRenderStateDelegate>(device, 57)(device, state, value); }
  public static int SetTexture(IntPtr device, uint stage, IntPtr texture) { return Fn<SetTextureDelegate>(device, 65)(device, stage, texture); }
  public static int SetTextureStageState(IntPtr device, uint stage, uint type, uint value) { return Fn<SetTextureStageStateDelegate>(device, 67)(device, stage, type, value); }
  public static int SetSamplerState(IntPtr device, uint sampler, uint type, uint value) { return Fn<SetSamplerStateDelegate>(device, 69)(device, sampler, type, value); }
  public static int SetFvf(IntPtr device, uint fvf) { return Fn<SetFvfDelegate>(device, 89)(device, fvf); }
  public static int DrawPrimitiveUp(IntPtr device, uint primitiveType, uint primitiveCount, IntPtr vertexData, uint vertexStride) {
   return Fn<DrawPrimitiveUpDelegate>(device, 83)(device, primitiveType, primitiveCount, vertexData, vertexStride);
  }
 }

 // D3DImage + Direct3D9Ex 渲染器。所有方法都必须在 UI 线程调（D3DImage 是 DispatcherObject，
 // Play 循环里经 Dispatcher.Invoke 调；RequestPreview 的续体也在 UI 线程）。
 sealed class GpuPreviewRenderer : IDisposable {
  readonly D3DImage image = new D3DImage();
  IntPtr d3d, device, videoTexture, chromeTexture, rtTexture, rtSurface;
  int videoW, videoH, chromeW, chromeH, rtW, rtH;
  bool failed, chromeReady;
  public D3DImage Image { get { return image; } }
  public bool Available { get { return !failed && device != IntPtr.Zero; } }

  public bool TryInitialize(IntPtr focusWindow) {
   try {
    int hr = D3D9.Direct3DCreate9Ex(D3D9.SDK_VERSION, out d3d);
    if (hr < 0 || d3d == IntPtr.Zero) return false;
    if (!TryCreateDevice(focusWindow, D3D9.CREATE_HARDWARE_VERTEXPROCESSING) &&
        !TryCreateDevice(focusWindow, D3D9.CREATE_SOFTWARE_VERTEXPROCESSING)) return false;
    return true;
   } catch { Cleanup(); return false; }
  }
  bool TryCreateDevice(IntPtr focusWindow, uint processing) {
   var pp = new D3D9.PresentParameters {
    BackBufferWidth = 0, BackBufferHeight = 0, BackBufferFormat = 0, BackBufferCount = 1,
    MultiSampleType = 0, MultiSampleQuality = 0, SwapEffect = D3D9.SWAPEFFECT_DISCARD,
    hDeviceWindow = focusWindow, Windowed = true, EnableAutoDepthStencil = false,
    AutoDepthStencilFormat = 0, Flags = 0, FullScreen_RefreshRateInHz = 0, PresentationInterval = 0
   };
   IntPtr dev;
   int hr = D3D9.CreateDeviceEx(d3d, 0, D3D9.DEVTYPE_HAL, focusWindow,
    processing | D3D9.CREATE_MULTITHREADED | D3D9.CREATE_FPU_PRESERVE, ref pp, out dev);
   if (hr < 0 || dev == IntPtr.Zero) return false;
   device = dev;
   return true;
  }
  bool Fail() { failed = true; return false; }
  bool EnsureRenderTarget(int w, int h) {
   if (rtTexture != IntPtr.Zero && rtW == w && rtH == h) return true;
   IntPtr newTex, newSurf;
   if (D3D9.CreateTexture(device, (uint)w, (uint)h, 1, D3D9.USAGE_RENDERTARGET, D3D9.FMT_A8R8G8B8, D3D9.POOL_DEFAULT, out newTex) < 0) return false;
   if (D3D9.GetSurfaceLevel(newTex, 0, out newSurf) < 0) { D3D9.Release(ref newTex); return false; }
   IntPtr oldTex = rtTexture, oldSurf = rtSurface;
   rtTexture = newTex; rtSurface = newSurf; rtW = w; rtH = h;
   image.Lock();
   try { image.SetBackBuffer(D3DResourceType.IDirect3DSurface9, rtSurface); } finally { image.Unlock(); }
   D3D9.Release(ref oldSurf); D3D9.Release(ref oldTex);
   return true;
  }
  bool EnsureTexture(ref IntPtr tex, ref int tw, ref int th, int w, int h) {
   if (tex != IntPtr.Zero && tw == w && th == h) return true;
   IntPtr nt;
   if (D3D9.CreateTexture(device, (uint)w, (uint)h, 1, D3D9.USAGE_DYNAMIC, D3D9.FMT_A8R8G8B8, D3D9.POOL_DEFAULT, out nt) < 0) return false;
   D3D9.Release(ref tex); tex = nt; tw = w; th = h; return true;
  }
  bool Upload(IntPtr texture, byte[] bgra, int w, int h) {
   D3D9.LockedRect locked;
   if (D3D9.LockRect(texture, 0, out locked, D3D9.LOCK_DISCARD) < 0) return false;
   try {
    int rowBytes = w * 4;
    if (locked.Pitch == rowBytes) Marshal.Copy(bgra, 0, locked.pBits, bgra.Length);
    else for (int y = 0; y < h; y++) Marshal.Copy(bgra, y * rowBytes, IntPtr.Add(locked.pBits, y * locked.Pitch), rowBytes);
    return true;
   } finally { D3D9.UnlockRect(texture, 0); }
  }
  bool DrawQuad(float x0, float y0, float x1, float y1, float u0, float v0, float u1, float v1, byte alpha) {
   uint color = ((uint)alpha << 24) | 0x00FFFFFF;
   var verts = new D3D9.Vertex[4];
   verts[0] = new D3D9.Vertex { X = x0, Y = y0, Z = 0, Rhw = 1, Color = color, U = u0, V = v0 };
   verts[1] = new D3D9.Vertex { X = x1, Y = y0, Z = 0, Rhw = 1, Color = color, U = u1, V = v0 };
   verts[2] = new D3D9.Vertex { X = x0, Y = y1, Z = 0, Rhw = 1, Color = color, U = u0, V = v1 };
   verts[3] = new D3D9.Vertex { X = x1, Y = y1, Z = 0, Rhw = 1, Color = color, U = u1, V = v1 };
   GCHandle handle = GCHandle.Alloc(verts, GCHandleType.Pinned);
   try { return D3D9.DrawPrimitiveUp(device, D3D9.PT_TRIANGLESTRIP, 2, handle.AddrOfPinnedObject(), 24) >= 0; }
   finally { handle.Free(); }
  }
  bool RenderScene(Func<bool> draw) {
   if (D3D9.SetRenderTarget(device, 0, rtSurface) < 0) return false;
   var vp = new D3D9.Viewport { X = 0, Y = 0, Width = (uint)rtW, Height = (uint)rtH, MinZ = 0, MaxZ = 1 };
   if (D3D9.SetViewport(device, ref vp) < 0) return false;
   if (D3D9.Clear(device, D3D9.CLEAR_TARGET, 0) < 0) return false;
   if (D3D9.BeginScene(device) < 0) return false;
   bool ok;
   try {
    D3D9.SetRenderState(device, D3D9.RS_ZENABLE, 0);
    D3D9.SetRenderState(device, D3D9.RS_LIGHTING, 0);
    D3D9.SetRenderState(device, D3D9.RS_CULLMODE, D3D9.CULL_NONE);
    D3D9.SetRenderState(device, D3D9.RS_ALPHATESTENABLE, 0);
    D3D9.SetFvf(device, D3D9.FVF_XYZRHW_DIFFUSE_TEX1);
    D3D9.SetSamplerState(device, 0, D3D9.SAMP_MAGFILTER, D3D9.TEXF_LINEAR);
    D3D9.SetSamplerState(device, 0, D3D9.SAMP_MINFILTER, D3D9.TEXF_LINEAR);
    D3D9.SetSamplerState(device, 0, D3D9.SAMP_MIPFILTER, D3D9.TEXF_NONE);
    D3D9.SetSamplerState(device, 0, D3D9.SAMP_ADDRESSU, D3D9.ADDRESS_CLAMP);
    D3D9.SetSamplerState(device, 0, D3D9.SAMP_ADDRESSV, D3D9.ADDRESS_CLAMP);
    D3D9.SetTextureStageState(device, 0, D3D9.TSS_COLOROP, D3D9.TOP_SELECTARG1);
    D3D9.SetTextureStageState(device, 0, D3D9.TSS_COLORARG1, D3D9.TA_TEXTURE);
    D3D9.SetTextureStageState(device, 0, D3D9.TSS_ALPHAOP, D3D9.TOP_MODULATE);
    D3D9.SetTextureStageState(device, 0, D3D9.TSS_ALPHAARG1, D3D9.TA_TEXTURE);
    D3D9.SetTextureStageState(device, 0, D3D9.TSS_ALPHAARG2, D3D9.TA_DIFFUSE);
    ok = draw();
   } finally { D3D9.EndScene(device); }
   if (!ok) return false;
   image.Lock();
   try { image.AddDirtyRect(new Int32Rect(0, 0, rtW, rtH)); } finally { image.Unlock(); }
   return true;
  }
  public bool SetChrome(byte[] bgra, int w, int h) {
   if (failed || device == IntPtr.Zero) return false;
   try {
    if (!EnsureTexture(ref chromeTexture, ref chromeW, ref chromeH, w, h)) return Fail();
    if (!Upload(chromeTexture, bgra, w, h)) return Fail();
    chromeReady = true; return true;
   } catch { return Fail(); }
  }
  // 整张合成好的帧（暂停预览、或 GPU 合成不适用时 Play 的回退）直接全屏贴出来。
  public bool PresentComposed(byte[] bgra, int w, int h) {
   if (failed || device == IntPtr.Zero) return false;
   try {
    if (!EnsureRenderTarget(w, h)) return Fail();
    if (!EnsureTexture(ref videoTexture, ref videoW, ref videoH, w, h)) return Fail();
    if (!Upload(videoTexture, bgra, w, h)) return Fail();
    return RenderScene(() => {
     D3D9.SetRenderState(device, D3D9.RS_ALPHABLENDENABLE, 0);
     D3D9.SetTexture(device, 0, videoTexture);
     return DrawQuad(0, 0, w, h, 0, 0, 1, 1, 255);
    });
   } catch { return Fail(); }
  }
  // 真 GPU 合成：解码帧按运镜裁剪贴在视频区，铬层盖在上面（视频区透明，圆角处框面盖住视频方角）。
  public bool PresentVideo(byte[] bgra, int vw, int vh, float dx, float dy, float dw, float dh, float u0, float v0, float u1, float v1, float opacity) {
   if (failed || device == IntPtr.Zero || !chromeReady) return false;
   try {
    if (!EnsureRenderTarget(chromeW, chromeH)) return Fail();
    if (!EnsureTexture(ref videoTexture, ref videoW, ref videoH, vw, vh)) return Fail();
    if (!Upload(videoTexture, bgra, vw, vh)) return Fail();
    return RenderScene(() => {
     byte alpha = (byte)(Math.Max(0, Math.Min(1, opacity)) * 255);
     D3D9.SetRenderState(device, D3D9.RS_ALPHABLENDENABLE, 0);
     D3D9.SetTexture(device, 0, videoTexture);
     if (!DrawQuad(dx, dy, dx + dw, dy + dh, u0, v0, u1, v1, alpha)) return false;
     D3D9.SetRenderState(device, D3D9.RS_ALPHABLENDENABLE, 1);
     D3D9.SetRenderState(device, D3D9.RS_SRCBLEND, D3D9.BLEND_SRCALPHA);
     D3D9.SetRenderState(device, D3D9.RS_DESTBLEND, D3D9.BLEND_INVSRCALPHA);
     D3D9.SetTexture(device, 0, chromeTexture);
     return DrawQuad(0, 0, chromeW, chromeH, 0, 0, 1, 1, 255);
    });
   } catch { return Fail(); }
  }
  void Cleanup() {
   D3D9.Release(ref rtSurface); D3D9.Release(ref rtTexture);
   D3D9.Release(ref chromeTexture); D3D9.Release(ref videoTexture);
   D3D9.Release(ref device); D3D9.Release(ref d3d);
  }
  public void Dispose() { Cleanup(); }
 }

 // 软件回退：WriteableBitmap 直接写像素。没有 GDI+ 重绘之外的额外开销，
 // 但合成仍走 GDI+ Compose（EditorApp 在 GPU 不可用时逐帧调 Compose 再传进来）。
 sealed class SoftwarePreview {
  WriteableBitmap bitmap; int w, h;
  public WriteableBitmap Bitmap { get { return bitmap; } }
  public void PresentComposed(byte[] bgra, int width, int height) {
   if (bitmap == null || w != width || h != height) { bitmap = new WriteableBitmap(width, height, 96, 96, PixelFormats.Bgra32, null); w = width; h = height; }
   bitmap.Lock();
   try {
    int rowBytes = width * 4;
    if (bitmap.BackBufferStride == rowBytes) Marshal.Copy(bgra, 0, bitmap.BackBuffer, bgra.Length);
    else for (int y = 0; y < height; y++) Marshal.Copy(bgra, y * rowBytes, IntPtr.Add(bitmap.BackBuffer, y * bitmap.BackBufferStride), rowBytes);
    bitmap.AddDirtyRect(new Int32Rect(0, 0, width, height));
   } finally { bitmap.Unlock(); }
  }
 }

 // 预览面：优先 D3D 硬件，建不起来就 WriteableBitmap；硬件中途失败也当场切软件，不抛。
 sealed class PreviewSurface : IDisposable {
  readonly Image host;
  GpuPreviewRenderer gpu;
  SoftwarePreview software;
  public bool IsHardware { get { return gpu != null && gpu.Available; } }
  public PreviewSurface(Image host, IntPtr focusWindow) {
   this.host = host;
   gpu = new GpuPreviewRenderer();
   if (gpu.TryInitialize(focusWindow)) host.Source = gpu.Image;
   else { gpu.Dispose(); gpu = null; }
  }
  public static byte[] BitmapBytes(D.Bitmap bitmap) {
   var data = bitmap.LockBits(new D.Rectangle(0, 0, bitmap.Width, bitmap.Height), System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
   try {
    var bytes = new byte[bitmap.Width * bitmap.Height * 4];
    if (data.Stride == bitmap.Width * 4) Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
    else for (int y = 0; y < bitmap.Height; y++) Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), bytes, y * bitmap.Width * 4, bitmap.Width * 4);
    return bytes;
   } finally { bitmap.UnlockBits(data); }
  }
  void FallbackToSoftware() {
   if (gpu != null) { gpu.Dispose(); gpu = null; }
   if (software == null) software = new SoftwarePreview();
  }
  public void PresentComposed(byte[] bgra, int w, int h) {
   if (IsHardware) { if (gpu.PresentComposed(bgra, w, h)) return; FallbackToSoftware(); }
   if (software == null) software = new SoftwarePreview();
   software.PresentComposed(bgra, w, h);
   if (host.Source != software.Bitmap) host.Source = software.Bitmap;
  }
  public bool SetChrome(byte[] bgra, int w, int h) {
   if (!IsHardware) return false;
   if (!gpu.SetChrome(bgra, w, h)) { FallbackToSoftware(); return false; }
   return true;
  }
  public bool TryPresentVideo(byte[] bgra, int vw, int vh, float dx, float dy, float dw, float dh, float u0, float v0, float u1, float v1, float opacity) {
   if (!IsHardware) return false;
   if (!gpu.PresentVideo(bgra, vw, vh, dx, dy, dw, dh, u0, v0, u1, v1, opacity)) { FallbackToSoftware(); return false; }
   return true;
  }
  public void Dispose() { if (gpu != null) { gpu.Dispose(); gpu = null; } }
 }
}
