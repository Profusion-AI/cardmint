#include "camera-wrapper.h"
#include <mutex>

// Simplified implementation to get basic functionality working
class CameraWrapper::Impl {
public:
    Impl() : connected(false), liveViewActive(false) {}
    
    ~Impl() {
        if (connected) {
            Disconnect();
        }
    }
    
    bool ConnectUSB(const std::string& deviceId) {
        // Simplified connection - just mark as connected for testing
        connected = true;
        return true;
    }
    
    bool ConnectEthernet(const std::string& ipAddress) {
        // Not implemented yet
        return false;
    }
    
    bool Disconnect() {
        connected = false;
        liveViewActive = false;
        return true;
    }
    
    void CaptureImageAsync(std::function<void(bool, const std::string&)> callback) {
        if (!connected) {
            callback(false, "Camera not connected");
            return;
        }
        
        // For now, return a test image path
        callback(true, "/tmp/test-capture.jpg");
    }
    
    bool StartLiveView(std::function<void(const uint8_t*, size_t)> callback) {
        if (!connected) {
            return false;
        }
        
        liveViewCallback = callback;
        liveViewActive = true;
        return true;
    }
    
    bool StopLiveView() {
        liveViewActive = false;
        liveViewCallback = nullptr;
        return true;
    }
    
    std::optional<std::string> GetProperty(const std::string& propertyName) {
        if (!connected) {
            return std::nullopt;
        }
        
        // Return mock values for testing
        if (propertyName == "model") return "Sony ZV-E10M2";
        if (propertyName == "iso") return "100";
        if (propertyName == "aperture") return "f/2.8";
        if (propertyName == "shutter") return "1/125";
        
        return std::nullopt;
    }
    
    bool SetProperty(const std::string& propertyName, const std::string& value) {
        if (!connected) {
            return false;
        }
        
        // Mock implementation - always succeed
        return true;
    }
    
    DeviceInfo GetDeviceInfo() {
        DeviceInfo info;
        info.connected = connected;
        info.model = connected ? "Sony ZV-E10M2" : "Not Connected";
        info.serialNumber = "1234567890";
        info.firmware = "1.0.0";
        return info;
    }
    
    std::vector<AvailableDevice> ListAvailableDevices() {
        std::vector<AvailableDevice> devices;
        
        AvailableDevice device;
        device.id = "054c:0ee9";
        device.name = "Sony ZV-E10M2";
        device.type = "USB";
        devices.push_back(device);
        
        return devices;
    }
    
private:
    bool connected;
    bool liveViewActive;
    std::function<void(const uint8_t*, size_t)> liveViewCallback;
    std::mutex mutex;
};

// Implementation of CameraWrapper public methods
CameraWrapper::CameraWrapper() : pImpl(std::make_unique<Impl>()) {}
CameraWrapper::~CameraWrapper() = default;

bool CameraWrapper::ConnectUSB(const std::string& deviceId) {
    return pImpl->ConnectUSB(deviceId);
}

bool CameraWrapper::ConnectEthernet(const std::string& ipAddress) {
    return pImpl->ConnectEthernet(ipAddress);
}

bool CameraWrapper::Disconnect() {
    return pImpl->Disconnect();
}

void CameraWrapper::CaptureImageAsync(std::function<void(bool, const std::string&)> callback) {
    pImpl->CaptureImageAsync(callback);
}

bool CameraWrapper::StartLiveView(std::function<void(const uint8_t*, size_t)> callback) {
    return pImpl->StartLiveView(callback);
}

bool CameraWrapper::StopLiveView() {
    return pImpl->StopLiveView();
}

std::optional<std::string> CameraWrapper::GetProperty(const std::string& propertyName) {
    return pImpl->GetProperty(propertyName);
}

bool CameraWrapper::SetProperty(const std::string& propertyName, const std::string& value) {
    return pImpl->SetProperty(propertyName, value);
}

DeviceInfo CameraWrapper::GetDeviceInfo() {
    return pImpl->GetDeviceInfo();
}

std::vector<AvailableDevice> CameraWrapper::ListAvailableDevices() {
    return pImpl->ListAvailableDevices();
}