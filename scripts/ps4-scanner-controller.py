#!/usr/bin/env python3
"""
PS4 Controller Integration for CardMint Scanner
Maps controller buttons to scanning workflow actions
"""

import evdev
from evdev import InputDevice, categorize, ecodes
import asyncio
import json
import requests
import subprocess
from pathlib import Path
import time
from datetime import datetime

# PS4 Controller Button Mappings
PS4_BUTTONS = {
    304: 'X',           # Cross - Capture card
    305: 'CIRCLE',      # Circle - Reject/Cancel
    306: 'SQUARE',      # Square - Edit mode
    307: 'TRIANGLE',    # Triangle - Approve
    308: 'L1',          # L1 - Previous card
    309: 'R1',          # R1 - Next card
    310: 'L2',          # L2 - Previous batch
    311: 'R2',          # R2 - Next batch
    312: 'SHARE',       # Share - Save session
    313: 'OPTIONS',     # Options - Menu
    314: 'PS',          # PS Button - Dashboard home
    315: 'L3',          # L3 (stick click) - Zoom
    316: 'R3',          # R3 (stick click) - Toggle view
}

# Axis mappings
PS4_AXES = {
    0: 'LEFT_X',        # Left stick X
    1: 'LEFT_Y',        # Left stick Y
    3: 'RIGHT_X',       # Right stick X - Navigate queue
    4: 'RIGHT_Y',       # Right stick Y - Scroll details
    2: 'L2_TRIGGER',    # L2 analog
    5: 'R2_TRIGGER',    # R2 analog
}

class PS4ScannerController:
    """PS4 Controller handler for CardMint scanning workflow."""
    
    def __init__(self):
        self.device = None
        self.current_queue_index = 0
        self.queue_items = []
        self.capture_enabled = True
        self.edit_mode = False
        self.last_capture_time = 0
        self.capture_cooldown = 1.0  # seconds between captures
        
        # CardMint paths
        self.capture_script = Path.home() / "CardMint" / "capture-card"
        self.dashboard_url = "http://localhost:3000"
        
        print("🎮 PS4 Scanner Controller Initialized")
        print("=" * 50)
        
    def find_ps4_controller(self):
        """Find PS4 controller device."""
        devices = [evdev.InputDevice(path) for path in evdev.list_devices()]
        for device in devices:
            if "Sony" in device.name or "Wireless Controller" in device.name:
                print(f"✅ Found PS4 Controller: {device.name}")
                print(f"   Path: {device.path}")
                return device
        return None
    
    async def connect(self):
        """Connect to PS4 controller."""
        self.device = self.find_ps4_controller()
        if not self.device:
            print("❌ PS4 Controller not found. Please connect via USB.")
            return False
        
        # Print capabilities
        print("\n📊 Controller Capabilities:")
        capabilities = self.device.capabilities(verbose=True)
        
        print("\n🎮 Control Mapping for CardMint:")
        print("-" * 50)
        print("  X Button     → Capture Card")
        print("  Triangle     → Approve")
        print("  Circle       → Reject")
        print("  Square       → Edit Mode")
        print("  R3 Stick     → Navigate Queue")
        print("  L1/R1        → Previous/Next Card")
        print("  L2/R2        → Previous/Next Batch")
        print("  Share        → Save Session")
        print("  Options      → Menu")
        print("  PS Button    → Dashboard Home")
        print("-" * 50)
        
        return True
    
    async def capture_card(self):
        """Trigger card capture."""
        current_time = time.time()
        if current_time - self.last_capture_time < self.capture_cooldown:
            return  # Cooldown active
        
        print(f"\n📸 Capturing card...")
        try:
            # Run capture script
            result = subprocess.run(
                [str(self.capture_script)],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                # Parse output for filename
                output = result.stdout.strip()
                print(f"✅ Captured: {output}")
                self.last_capture_time = current_time
                
                # Send to dashboard via API
                await self.notify_dashboard('capture', {'file': output})
            else:
                print(f"❌ Capture failed: {result.stderr}")
        except Exception as e:
            print(f"❌ Capture error: {e}")
    
    async def approve_card(self):
        """Approve current card in queue."""
        if self.current_queue_index < len(self.queue_items):
            card = self.queue_items[self.current_queue_index]
            print(f"✅ Approved: {card.get('name', 'Unknown')}")
            await self.notify_dashboard('approve', {'id': card['id']})
            self.next_card()
    
    async def reject_card(self):
        """Reject current card in queue."""
        if self.current_queue_index < len(self.queue_items):
            card = self.queue_items[self.current_queue_index]
            print(f"❌ Rejected: {card.get('name', 'Unknown')}")
            await self.notify_dashboard('reject', {'id': card['id']})
            self.next_card()
    
    def next_card(self):
        """Move to next card in queue."""
        if self.current_queue_index < len(self.queue_items) - 1:
            self.current_queue_index += 1
            card = self.queue_items[self.current_queue_index]
            print(f"→ Next card: {card.get('name', 'Unknown')} [{self.current_queue_index + 1}/{len(self.queue_items)}]")
    
    def previous_card(self):
        """Move to previous card in queue."""
        if self.current_queue_index > 0:
            self.current_queue_index -= 1
            card = self.queue_items[self.current_queue_index]
            print(f"← Previous card: {card.get('name', 'Unknown')} [{self.current_queue_index + 1}/{len(self.queue_items)}]")
    
    async def handle_button(self, code, value):
        """Handle button press."""
        if value == 0:  # Button release
            return
        
        button = PS4_BUTTONS.get(code, f"Unknown_{code}")
        
        if button == 'X':
            await self.capture_card()
        elif button == 'TRIANGLE':
            await self.approve_card()
        elif button == 'CIRCLE':
            await self.reject_card()
        elif button == 'SQUARE':
            self.edit_mode = not self.edit_mode
            print(f"📝 Edit mode: {'ON' if self.edit_mode else 'OFF'}")
        elif button == 'L1':
            self.previous_card()
        elif button == 'R1':
            self.next_card()
        elif button == 'SHARE':
            await self.save_session()
        elif button == 'OPTIONS':
            await self.show_menu()
        elif button == 'PS':
            await self.go_home()
    
    async def handle_axis(self, code, value):
        """Handle analog stick movement."""
        axis = PS4_AXES.get(code, f"Unknown_{code}")
        
        # Right stick for queue navigation
        if axis == 'RIGHT_Y':
            if value < -16000:  # Up
                self.previous_card()
            elif value > 16000:  # Down
                self.next_card()
        elif axis == 'RIGHT_X':
            if value < -16000:  # Left
                print("← Scrolling details left")
            elif value > 16000:  # Right
                print("→ Scrolling details right")
    
    async def notify_dashboard(self, action, data):
        """Send action to dashboard via WebSocket/API."""
        try:
            # For now, just log - will integrate with actual dashboard
            print(f"📡 Dashboard: {action} → {data}")
            
            # When dashboard is ready:
            # requests.post(f"{self.dashboard_url}/api/controller/{action}", json=data)
        except Exception as e:
            print(f"Dashboard notification error: {e}")
    
    async def save_session(self):
        """Save current scanning session."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        print(f"💾 Saving session: {timestamp}")
        await self.notify_dashboard('save_session', {'timestamp': timestamp})
    
    async def show_menu(self):
        """Show options menu."""
        print("\n📋 MENU:")
        print("  1. Session Stats")
        print("  2. Queue Status")
        print("  3. Settings")
        print("  4. Help")
    
    async def go_home(self):
        """Return to dashboard home."""
        print("🏠 Returning to dashboard home")
        await self.notify_dashboard('home', {})
    
    async def vibrate(self, duration=0.1):
        """Vibrate controller for feedback."""
        # PS4 rumble would go here if we had write access
        pass
    
    async def run(self):
        """Main event loop."""
        if not await self.connect():
            return
        
        print("\n🎮 Controller ready! Press X to capture cards...")
        print("Press Ctrl+C to exit\n")
        
        try:
            async for event in self.device.async_read_loop():
                if event.type == ecodes.EV_KEY:
                    await self.handle_button(event.code, event.value)
                elif event.type == ecodes.EV_ABS:
                    await self.handle_axis(event.code, event.value)
        except KeyboardInterrupt:
            print("\n👋 Shutting down PS4 Scanner Controller")
        except Exception as e:
            print(f"Error: {e}")

async def main():
    """Main entry point."""
    print("🎮 CardMint PS4 Scanner Controller")
    print("=" * 50)
    
    controller = PS4ScannerController()
    await controller.run()

if __name__ == "__main__":
    # Check if running as root (might be needed for device access)
    import os
    if os.geteuid() != 0:
        print("⚠️  Note: You may need to run with sudo for device access")
        print("   Or add your user to the 'input' group:")
        print("   sudo usermod -a -G input $USER")
        print()
    
    asyncio.run(main())