#include <napi.h>
#include <memory>
#include <thread>
#include <chrono>
#include <vector>
#include <atomic>
#include <cstring>
#include "CRSDK/CameraRemote_SDK.h"
#include "CRSDK/IDeviceCallback.h"

namespace SDK = SCRSDK;
using namespace std::chrono_literals;

// Ensure CrDeviceHandle is defined
typedef CrInt64 CrDeviceHandle;

class SonyCamera : public Napi::ObjectWrap<SonyCamera>, public SDK::IDeviceCallback {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    SonyCamera(const Napi::CallbackInfo& info);
    ~SonyCamera();

    // IDeviceCallback overrides
    virtual void OnConnected(SDK::DeviceConnectionVersioin version) override {}
    virtual void OnDisconnected(CrInt32u error) override { m_connected = false; }
    virtual void OnPropertyChanged() override {}
    virtual void OnLvPropertyChanged() override {}
    virtual void OnCompleted(CrInt32u tag, SDK::CrFrameInfoType type, CrInt32 status) override {}
    virtual void OnError(CrInt32u tag, SDK::CrFrameInfoType type, CrInt32 status) override {}
    virtual void OnWarning(CrInt32u tag, SDK::CrFrameInfoType type, CrInt32 status) override {}

private:
    static Napi::FunctionReference constructor;
    
    // API Methods
    Napi::Value Connect(const Napi::CallbackInfo& info);
    Napi::Value Disconnect(const Napi::CallbackInfo& info);
    Napi::Value CaptureImage(const Napi::CallbackInfo& info);
    Napi::Value GetDeviceInfo(const Napi::CallbackInfo& info);
    Napi::Value ListDevices(const Napi::CallbackInfo& info);
    Napi::Value GetProperty(const Napi::CallbackInfo& info);
    Napi::Value SetProperty(const Napi::CallbackInfo& info);
    Napi::Value StartLiveView(const Napi::CallbackInfo& info);
    Napi::Value StopLiveView(const Napi::CallbackInfo& info);
    
    // Member variables
    SDK::ICrCameraObjectInfo* m_camera_info = nullptr;
    CrDeviceHandle m_device_handle = 0;
    std::atomic<bool> m_connected{false};
    std::atomic<bool> m_sdk_initialized{false};
    std::vector<SDK::ICrCameraObjectInfo*> m_camera_list;
};

Napi::FunctionReference SonyCamera::constructor;

SonyCamera::SonyCamera(const Napi::CallbackInfo& info) 
    : Napi::ObjectWrap<SonyCamera>(info) {
    // Initialize SDK if not already done
    if (!m_sdk_initialized) {
        auto init_result = SDK::Init();
        if (CR_SUCCEEDED(init_result)) {
            m_sdk_initialized = true;
        }
    }
}

SonyCamera::~SonyCamera() {
    if (m_connected && m_device_handle) {
        SDK::Disconnect(m_device_handle);
        SDK::ReleaseDevice(m_device_handle);
    }
    if (m_sdk_initialized) {
        SDK::Release();
    }
}

Napi::Value SonyCamera::ListDevices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array devices = Napi::Array::New(env);
    
    SDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
    auto result = SDK::EnumCameraObjects(&camera_list);
    
    if (CR_SUCCEEDED(result) && camera_list) {
        auto count = camera_list->GetCount();
        
        for (CrInt32u i = 0; i < count; ++i) {
            auto* cam_info = camera_list->GetCameraObjectInfo(i);
            if (cam_info) {
                Napi::Object device = Napi::Object::New(env);
                
                CrChar model[256] = {0};
                cam_info->GetModel(model, sizeof(model));
                
                CrChar id[256] = {0};
                cam_info->GetId(id, sizeof(id));
                
                device.Set("model", Napi::String::New(env, (char*)model));
                device.Set("id", Napi::String::New(env, (char*)id));
                device.Set("index", Napi::Number::New(env, i));
                
                devices.Set(i, device);
                cam_info->Release();
            }
        }
        camera_list->Release();
    }
    
    return devices;
}

Napi::Value SonyCamera::Connect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    // Clear previous camera list
    for (auto* cam : m_camera_list) {
        cam->Release();
    }
    m_camera_list.clear();
    
    // Enumerate cameras
    SDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
    auto result = SDK::EnumCameraObjects(&camera_list);
    
    if (CR_FAILED(result) || !camera_list) {
        return Napi::Boolean::New(env, false);
    }
    
    auto count = camera_list->GetCount();
    if (count == 0) {
        camera_list->Release();
        return Napi::Boolean::New(env, false);
    }
    
    // Get first camera
    m_camera_info = camera_list->GetCameraObjectInfo(0);
    camera_list->Release();
    
    if (!m_camera_info) {
        return Napi::Boolean::New(env, false);
    }
    
    // Connect to camera in Remote Control mode
    SDK::CrSdkControlMode mode = SDK::CrSdkControlMode_Remote;
    SDK::CrReconnectingSet reconnect = SDK::CrReconnectingSet_ON;
    
    auto connect_result = SDK::Connect(
        m_camera_info, 
        this,  // IDeviceCallback
        &m_device_handle,
        mode,
        reconnect
    );
    
    if (CR_SUCCEEDED(connect_result)) {
        m_connected = true;
        return Napi::Boolean::New(env, true);
    }
    
    return Napi::Boolean::New(env, false);
}

Napi::Value SonyCamera::Disconnect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected || !m_device_handle) {
        return Napi::Boolean::New(env, false);
    }
    
    auto result = SDK::Disconnect(m_device_handle);
    
    if (CR_SUCCEEDED(result)) {
        SDK::ReleaseDevice(m_device_handle);
        m_device_handle = 0;
        m_connected = false;
        
        if (m_camera_info) {
            m_camera_info->Release();
            m_camera_info = nullptr;
        }
        
        return Napi::Boolean::New(env, true);
    }
    
    return Napi::Boolean::New(env, false);
}

Napi::Value SonyCamera::CaptureImage(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected || !m_device_handle) {
        Napi::Error::New(env, "Camera not connected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    // Create promise for async operation
    Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
    
    // Send shutter command
    auto result = SDK::SendCommand(
        m_device_handle,
        SDK::CrCommandId::CrCommandId_Release,
        SDK::CrCommandParam::CrCommandParam_Down
    );
    
    if (CR_SUCCEEDED(result)) {
        // Wait a bit then release shutter
        std::this_thread::sleep_for(35ms);
        
        SDK::SendCommand(
            m_device_handle,
            SDK::CrCommandId::CrCommandId_Release,
            SDK::CrCommandParam::CrCommandParam_Up
        );
        
        // Generate dummy file path for now
        std::string path = "/tmp/capture_" + std::to_string(time(nullptr)) + ".jpg";
        deferred.Resolve(Napi::String::New(env, path));
    } else {
        deferred.Reject(Napi::Error::New(env, "Capture failed").Value());
    }
    
    return deferred.Promise();
}

Napi::Value SonyCamera::GetDeviceInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    
    if (m_camera_info) {
        CrChar model[256] = {0};
        m_camera_info->GetModel(model, sizeof(model));
        
        CrChar id[256] = {0};
        m_camera_info->GetId(id, sizeof(id));
        
        result.Set("model", Napi::String::New(env, (char*)model));
        result.Set("id", Napi::String::New(env, (char*)id));
        result.Set("connected", Napi::Boolean::New(env, m_connected.load()));
    } else {
        result.Set("model", "No camera");
        result.Set("id", "");
        result.Set("connected", false);
    }
    
    return result;
}

Napi::Value SonyCamera::GetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected || !m_device_handle) {
        return env.Null();
    }
    
    // Simplified property getter
    return env.Null();
}

Napi::Value SonyCamera::SetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected || !m_device_handle) {
        return Napi::Boolean::New(env, false);
    }
    
    // Simplified property setter
    return Napi::Boolean::New(env, true);
}

Napi::Value SonyCamera::StartLiveView(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected || !m_device_handle) {
        return Napi::Boolean::New(env, false);
    }
    
    // Enable live view would go here
    return Napi::Boolean::New(env, true);
}

Napi::Value SonyCamera::StopLiveView(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected || !m_device_handle) {
        return Napi::Boolean::New(env, false);
    }
    
    // Disable live view would go here
    return Napi::Boolean::New(env, true);
}

Napi::Object SonyCamera::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "SonyCamera", {
        InstanceMethod("connect", &SonyCamera::Connect),
        InstanceMethod("disconnect", &SonyCamera::Disconnect),
        InstanceMethod("captureImage", &SonyCamera::CaptureImage),
        InstanceMethod("getDeviceInfo", &SonyCamera::GetDeviceInfo),
        InstanceMethod("listDevices", &SonyCamera::ListDevices),
        InstanceMethod("getProperty", &SonyCamera::GetProperty),
        InstanceMethod("setProperty", &SonyCamera::SetProperty),
        InstanceMethod("startLiveView", &SonyCamera::StartLiveView),
        InstanceMethod("stopLiveView", &SonyCamera::StopLiveView),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("SonyCamera", func);
    return exports;
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
    return SonyCamera::Init(env, exports);
}

NODE_API_MODULE(sony_camera_binding, InitAll)