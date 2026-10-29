// Window-only capture. No desktop, screen-region or GDI fallback.
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <dwmapi.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <cerrno>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

namespace {
constexpr uint64_t maximumPixels = 8 * 1024 * 1024;
// Base64 and escaped accessibility text must fit the 3 MiB transport envelope.
constexpr uint64_t maximumPng = 1792 * 1024;

uint64_t number(const wchar_t* value) {
    size_t length = wcslen(value);
    if (length == 0 || length > 20 || value[0] == L'0') throw std::runtime_error("Invalid identity");
    for (size_t i = 0; i < length; ++i)
        if (value[i] < L'0' || value[i] > L'9') throw std::runtime_error("Invalid identity");
    errno = 0;
    wchar_t* end = nullptr;
    auto result = wcstoull(value, &end, 10);
    if (errno == ERANGE || *end != L'\0') throw std::runtime_error("Invalid identity");
    return result;
}

struct Handle {
    HANDLE value;
    explicit Handle(HANDLE input) : value(input) {
        if (!value || value == INVALID_HANDLE_VALUE) throw std::runtime_error("Unavailable process");
    }
    ~Handle() { CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};

void checkTarget(HWND window, DWORD pid, uint64_t started, HANDLE process) {
    DWORD actualPid = 0, status = 0, session = 0, ownSession = 0;
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!IsWindow(window) || !IsWindowVisible(window) || IsIconic(window) ||
        window == GetDesktopWindow() || window == GetShellWindow() ||
        GetAncestor(window, GA_ROOT) != window ||
        !GetWindowThreadProcessId(window, &actualPid) || actualPid != pid ||
        !ProcessIdToSessionId(pid, &session) ||
        !ProcessIdToSessionId(GetCurrentProcessId(), &ownSession) ||
        session == 0 || session != ownSession ||
        !GetExitCodeProcess(process, &status) || status != STILL_ACTIVE ||
        !GetProcessTimes(process, &created, &exited, &kernel, &user) ||
        ((uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime) != started)
        throw std::runtime_error("Window identity changed");
}

void checkSize(int width, int height) {
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192 ||
        uint64_t(width) * uint64_t(height) > maximumPixels)
        throw std::runtime_error("Unsupported frame size");
}

std::vector<BYTE> png(const std::vector<BYTE>& pixels, UINT width, UINT height) {
    com_ptr<IWICImagingFactory> factory;
    check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
        __uuidof(IWICImagingFactory), factory.put_void()));
    com_ptr<IStream> stream;
    check_hresult(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()));
    com_ptr<IWICBitmapEncoder> encoder;
    check_hresult(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()));
    check_hresult(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache));
    com_ptr<IWICBitmapFrameEncode> frame;
    check_hresult(encoder->CreateNewFrame(frame.put(), nullptr));
    check_hresult(frame->Initialize(nullptr));
    check_hresult(frame->SetSize(width, height));
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    check_hresult(frame->SetPixelFormat(&format));
    if (format != GUID_WICPixelFormat32bppBGRA) throw std::runtime_error("Unexpected PNG format");
    check_hresult(frame->WritePixels(height, width * 4, static_cast<UINT>(pixels.size()),
        const_cast<BYTE*>(pixels.data())));
    check_hresult(frame->Commit());
    check_hresult(encoder->Commit());
    STATSTG stat{};
    check_hresult(stream->Stat(&stat, STATFLAG_NONAME));
    if (stat.cbSize.QuadPart == 0 || stat.cbSize.QuadPart > maximumPng)
        throw std::runtime_error("PNG exceeds capture budget");
    std::vector<BYTE> result(static_cast<size_t>(stat.cbSize.QuadPart));
    LARGE_INTEGER start{};
    check_hresult(stream->Seek(start, STREAM_SEEK_SET, nullptr));
    ULONG read = 0;
    check_hresult(stream->Read(result.data(), static_cast<ULONG>(result.size()), &read));
    if (read != result.size()) throw std::runtime_error("Incomplete PNG");
    return result;
}

std::vector<BYTE> capture(HWND window, DWORD pid, uint64_t started, HANDLE process) {
    checkTarget(window, pid, started, process);
    if (!GraphicsCaptureSession::IsSupported()) throw std::runtime_error("Window capture unavailable");
    auto factory = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{nullptr};
    check_hresult(factory->CreateForWindow(window, guid_of<GraphicsCaptureItem>(), put_abi(item)));
    auto size = item.Size();
    checkSize(size.Width, size.Height);
    RECT bounds{}, outer{};
    check_hresult(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds)));
    if (!GetWindowRect(window, &outer)) throw std::runtime_error("Window bounds are unavailable");
    const int64_t frameWidth = int64_t(bounds.right) - bounds.left;
    const int64_t frameHeight = int64_t(bounds.bottom) - bounds.top;
    // WGC may include invisible resize margins. Accept only an independently
    // identified whole-window or DWM surface, then crop to the visible frame.
    const bool whole = size.Width == int64_t(outer.right) - outer.left &&
        size.Height == int64_t(outer.bottom) - outer.top;
    const bool visible = size.Width == frameWidth && size.Height == frameHeight;
    if ((!whole && !visible) || (whole && visible &&
        (outer.left != bounds.left || outer.top != bounds.top)))
        throw std::runtime_error("Unknown window capture origin");
    const int64_t originX = whole ? outer.left : bounds.left;
    const int64_t originY = whole ? outer.top : bounds.top;
    const int64_t offsetX = int64_t(bounds.left) - originX + 1;
    const int64_t offsetY = int64_t(bounds.top) - originY + 1;
    if (frameWidth <= 2 || frameHeight <= 2 || offsetX < 0 || offsetY < 0 ||
        offsetX + frameWidth - 2 > size.Width || offsetY + frameHeight - 2 > size.Height)
        throw std::runtime_error("Visible frame is outside the capture surface");
    const UINT width = static_cast<UINT>(frameWidth - 2), height = static_cast<UINT>(frameHeight - 2);

    com_ptr<ID3D11Device> device;
    com_ptr<ID3D11DeviceContext> context;
    HRESULT created = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
        device.put(), nullptr, context.put());
    if (FAILED(created)) {
        device = nullptr;
        context = nullptr;
        check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
            device.put(), nullptr, context.put()));
    }
    com_ptr<IInspectable> interop;
    check_hresult(CreateDirect3D11DeviceFromDXGIDevice(device.as<IDXGIDevice>().get(), interop.put()));
    auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        interop.as<IDirect3DDevice>(), DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size);
    auto session = pool.CreateCaptureSession(item);
    session.IsCursorCaptureEnabled(false);
    session.StartCapture();
    Direct3D11CaptureFrame frame{nullptr};
    const ULONGLONG deadline = GetTickCount64() + 3000;
    while (!(frame = pool.TryGetNextFrame())) {
        checkTarget(window, pid, started, process);
        if (GetTickCount64() >= deadline) throw std::runtime_error("Window capture timed out");
        Sleep(5);
    }
    auto content = frame.ContentSize();
    if (content.Width != size.Width || content.Height != size.Height)
        throw std::runtime_error("Window resized during capture");
    com_ptr<ID3D11Texture2D> texture;
    check_hresult(frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>()->GetInterface(
        __uuidof(ID3D11Texture2D), texture.put_void()));
    D3D11_TEXTURE2D_DESC description{};
    texture->GetDesc(&description);
    checkSize(static_cast<int>(description.Width), static_cast<int>(description.Height));
    if (description.Width < static_cast<UINT>(size.Width) || description.Height < static_cast<UINT>(size.Height) ||
        description.Format != DXGI_FORMAT_B8G8R8A8_UNORM || description.ArraySize != 1 || description.MipLevels != 1)
        throw std::runtime_error("Unexpected capture surface");
    description.Usage = D3D11_USAGE_STAGING;
    description.BindFlags = 0;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    description.MiscFlags = 0;
    com_ptr<ID3D11Texture2D> staging;
    check_hresult(device->CreateTexture2D(&description, nullptr, staging.put()));
    context->CopyResource(staging.get(), texture.get());
    // Match the pinned SDK input origin: physical DWM bounds with a one-pixel inset.
    const size_t stride = static_cast<size_t>(width) * 4;
    std::vector<BYTE> pixels(stride * height);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
    if (mapped.RowPitch < static_cast<size_t>(size.Width) * 4) {
        context->Unmap(staging.get(), 0);
        throw std::runtime_error("Invalid capture stride");
    }
    for (UINT y = 0; y < height; ++y)
        memcpy(pixels.data() + static_cast<size_t>(y) * stride,
            static_cast<const BYTE*>(mapped.pData) + (static_cast<size_t>(y) + static_cast<size_t>(offsetY)) * mapped.RowPitch + static_cast<size_t>(offsetX) * 4, stride);
    context->Unmap(staging.get(), 0);
    frame.Close();
    session.Close();
    pool.Close();
    checkTarget(window, pid, started, process);
    if (item.Size().Width != size.Width || item.Size().Height != size.Height)
        throw std::runtime_error("Window resized during capture");
    RECT after{}, outerAfter{};
    check_hresult(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &after, sizeof(after)));
    if (!GetWindowRect(window, &outerAfter) ||
        outerAfter.left != outer.left || outerAfter.top != outer.top || outerAfter.right != outer.right || outerAfter.bottom != outer.bottom ||
        after.left != bounds.left || after.top != bounds.top || after.right != bounds.right || after.bottom != bounds.bottom)
        throw std::runtime_error("Window moved during capture");
    return png(pixels, width, height);
}
}

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc != 4 || GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_PIPE)
            throw std::runtime_error("A private capture pipe is required");
        uint64_t pid = number(argv[1]), hwnd = number(argv[2]), started = number(argv[3]);
        if (pid > MAXDWORD || hwnd > std::numeric_limits<UINT_PTR>::max())
            throw std::runtime_error("Invalid identity");
        if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
            throw std::runtime_error("Physical window coordinates are unavailable");
        init_apartment(apartment_type::multi_threaded);
        HWND window = reinterpret_cast<HWND>(static_cast<UINT_PTR>(hwnd));
        Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid)));
        auto bytes = capture(window, static_cast<DWORD>(pid), started, process.value);
        checkTarget(window, static_cast<DWORD>(pid), started, process.value);
        size_t offset = 0;
        while (offset < bytes.size()) {
            DWORD written = 0;
            if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes.data() + offset,
                static_cast<DWORD>(bytes.size() - offset), &written, nullptr) || written == 0)
                throw std::runtime_error("Capture pipe closed");
            offset += written;
        }
        return 0;
    } catch (const winrt::hresult_error& error) {
        char message[96];
        int length = sprintf_s(message, "Mira window-only capture failed (0x%08lX).\n", static_cast<unsigned long>(error.code().value));
        DWORD ignored;
        if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), message, static_cast<DWORD>(length), &ignored, nullptr);
        return 1;
    } catch (...) {
        const char message[] = "Mira window-only capture is unavailable.\n";
        DWORD ignored;
        WriteFile(GetStdHandle(STD_ERROR_HANDLE), message, sizeof(message) - 1, &ignored, nullptr);
        return 1;
    }
}
