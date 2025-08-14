#include <napi.h>
#include <thread>
#include <chrono>
#include <vector>
#include <cstring>
#include <iostream>
#include "CRSDK/CameraRemote_SDK.h"
#include "CRSDK/IDeviceCallback.h"

namespace SDK = SCRSDK;
using namespace std::chrono_literals;

class SimpleCamera : public SDK::IDeviceCallback {
private:
    SDK::ICrCameraObjectInfo* m_info = nullptr;
    CrInt64 m_handle = 0;
    bool m_connected = false;
    
public:
    SimpleCamera() {
        auto init_success = SDK::Init();
        if (!init_success) {
            std::cerr << "Failed to initialize Sony SDK" << std::endl;
        }
    }
    
    ~SimpleCamera() {
        if (m_connected) {
            disconnect();
        }
        SDK::Release();
    }
    
    bool connect() {
        SDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
        auto result = SDK::EnumCameraObjects(&camera_list);
        
        if (CR_FAILED(result) || !camera_list) {
            return false;
        }
        
        auto count = camera_list->GetCount();
        if (count == 0) {
            camera_list->Release();
            return false;
        }
        
        auto cam_info = camera_list->GetCameraObjectInfo(0);
        m_info = const_cast<SDK::ICrCameraObjectInfo*>(cam_info);
        camera_list->Release();
        
        if (!m_info) {
            return false;
        }
        
        result = SDK::Connect(
            m_info,
            this,
            &m_handle,
            SDK::CrSdkControlMode_Remote,
            SDK::CrReconnecting_ON
        );
        
        if (CR_SUCCEEDED(result)) {
            m_connected = true;
            return true;
        }
        
        return false;
    }
    
    bool disconnect() {
        if (m_connected && m_handle) {
            SDK::Disconnect(m_handle);
            SDK::ReleaseDevice(m_handle);
            m_handle = 0;
            m_connected = false;
            return true;
        }
        return false;
    }
    
    bool capture() {
        if (!m_connected || !m_handle) {
            return false;
        }
        
        // Shutter down
        SDK::SendCommand(m_handle, SDK::CrCommandId::CrCommandId_Release, SDK::CrCommandParam_Down);
        std::this_thread::sleep_for(35ms);
        
        // Shutter up
        SDK::SendCommand(m_handle, SDK::CrCommandId::CrCommandId_Release, SDK::CrCommandParam_Up);
        
        return true;
    }
    
    std::string getModelName() {
        if (m_info) {
            CrChar* model = m_info->GetModel();
            if (model) {
                return std::string((char*)model);
            }
        }
        return "No camera";
    }
    
    bool isConnected() const { 
        return m_connected; 
    }
};

// Node.js wrapper
class SonyCameraWrapper : public Napi::ObjectWrap<SonyCameraWrapper> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "SonyCamera", {
            InstanceMethod("connect", &SonyCameraWrapper::Connect),
            InstanceMethod("disconnect", &SonyCameraWrapper::Disconnect),
            InstanceMethod("captureImage", &SonyCameraWrapper::CaptureImage),
            InstanceMethod("getDeviceInfo", &SonyCameraWrapper::GetDeviceInfo),
            InstanceMethod("listDevices", &SonyCameraWrapper::ListDevices),
            InstanceMethod("getProperty", &SonyCameraWrapper::GetProperty),
            InstanceMethod("setProperty", &SonyCameraWrapper::SetProperty),
            InstanceMethod("startLiveView", &SonyCameraWrapper::StartLiveView),
            InstanceMethod("stopLiveView", &SonyCameraWrapper::StopLiveView),
        });
        
        constructor = Napi::Persistent(func);
        constructor.SuppressDestruct();
        
        exports.Set("SonyCamera", func);
        return exports;
    }
    
    SonyCameraWrapper(const Napi::CallbackInfo& info) 
        : Napi::ObjectWrap<SonyCameraWrapper>(info) {
        m_camera = std::make_unique<SimpleCamera>();
    }
    
private:
    static Napi::FunctionReference constructor;
    std::unique_ptr<SimpleCamera> m_camera;
    
    Napi::Value Connect(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        bool result = m_camera->connect();
        return Napi::Boolean::New(env, result);
    }
    
    Napi::Value Disconnect(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        bool result = m_camera->disconnect();
        return Napi::Boolean::New(env, result);
    }
    
    Napi::Value CaptureImage(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        if (!m_camera->isConnected()) {
            Napi::Error::New(env, "Camera not connected").ThrowAsJavaScriptException();
            return env.Null();
        }
        
        Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
        
        bool result = m_camera->capture();
        
        if (result) {
            std::string path = "/tmp/sony_capture_" + std::to_string(time(nullptr)) + ".jpg";
            deferred.Resolve(Napi::String::New(env, path));
        } else {
            deferred.Reject(Napi::Error::New(env, "Capture failed").Value());
        }
        
        return deferred.Promise();
    }
    
    Napi::Value GetDeviceInfo(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        Napi::Object result = Napi::Object::New(env);
        
        result.Set("model", Napi::String::New(env, m_camera->getModelName()));
        result.Set("connected", Napi::Boolean::New(env, m_camera->isConnected()));
        
        return result;
    }
    
    Napi::Value ListDevices(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        Napi::Array devices = Napi::Array::New(env);
        
        SDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
        auto result = SDK::EnumCameraObjects(&camera_list);
        
        if (CR_SUCCEEDED(result) && camera_list) {
            auto count = camera_list->GetCount();
            
            for (CrInt32u i = 0; i < count; ++i) {
                auto cam_info = camera_list->GetCameraObjectInfo(i);
                if (cam_info) {
                    Napi::Object device = Napi::Object::New(env);
                    
                    CrChar* model = cam_info->GetModel();
                    CrInt8u* id = cam_info->GetId();
                    
                    device.Set("model", Napi::String::New(env, model ? (char*)model : "Unknown"));
                    device.Set("id", Napi::String::New(env, id ? (char*)id : ""));
                    device.Set("index", Napi::Number::New(env, i));
                    
                    devices.Set(i, device);
                    // Note: cam_info is const, managed by camera_list
                }
            }
            camera_list->Release();
        }
        
        return devices;
    }
    
    Napi::Value GetProperty(const Napi::CallbackInfo& info) {
        return info.Env().Null();
    }
    
    Napi::Value SetProperty(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(), true);
    }
    
    Napi::Value StartLiveView(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(), true);
    }
    
    Napi::Value StopLiveView(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(), true);
    }
};

Napi::FunctionReference SonyCameraWrapper::constructor;

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
    return SonyCameraWrapper::Init(env, exports);
}

NODE_API_MODULE(sony_camera_binding, InitAll)