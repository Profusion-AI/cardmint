#ifndef CAMERA_WRAPPER_H
#define CAMERA_WRAPPER_H

#include <string>
#include <vector>
#include <functional>
#include <optional>
#include <memory>
#include <cstdint>

struct DeviceInfo {
    std::string model;
    std::string serialNumber;
    std::string firmware;
    bool connected;
};

struct AvailableDevice {
    std::string id;
    std::string name;
    std::string type;
};

class CameraWrapper {
public:
    CameraWrapper();
    ~CameraWrapper();
    
    bool ConnectUSB(const std::string& deviceId);
    bool ConnectEthernet(const std::string& ipAddress);
    bool Disconnect();
    
    void CaptureImageAsync(std::function<void(bool, const std::string&)> callback);
    
    bool StartLiveView(std::function<void(const uint8_t*, size_t)> callback);
    bool StopLiveView();
    
    std::optional<std::string> GetProperty(const std::string& propertyName);
    bool SetProperty(const std::string& propertyName, const std::string& value);
    
    DeviceInfo GetDeviceInfo();
    std::vector<AvailableDevice> ListAvailableDevices();
    
private:
    class Impl;
    std::unique_ptr<Impl> pImpl;
};

#endif // CAMERA_WRAPPER_H