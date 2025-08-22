#!/usr/bin/env python3
"""
CardMint Monitor for Fedora
Real-time monitoring dashboard for card scanning operations
"""

import os
import sys
import time
import json
from pathlib import Path
from datetime import datetime, timedelta
import threading
from collections import deque

# Try to import rich for better terminal UI
try:
    from rich.console import Console
    from rich.table import Table
    from rich.live import Live
    from rich.panel import Panel
    from rich.layout import Layout
    from rich.progress import Progress, SpinnerColumn, TextColumn
    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False
    print("Install 'rich' for better UI: pip install rich")

class CardMintMonitor:
    """Monitor for CardMint scanning operations."""
    
    def __init__(self):
        self.scan_dir = Path.home() / "CardMint" / "scans"
        self.processed_dir = Path.home() / "CardMint" / "processed"
        self.inventory_file = Path.home() / "CardMint" / "inventory.json"
        self.log_file = Path.home() / "CardMint" / "logs" / "scanner.log"
        
        # Statistics
        self.stats = {
            'total_scanned': 0,
            'successful': 0,
            'failed': 0,
            'avg_confidence': 0.0,
            'session_start': datetime.now(),
            'last_scan': None
        }
        
        # Recent activity
        self.recent_cards = deque(maxlen=10)
        self.scan_rate = deque(maxlen=60)  # Last 60 seconds
        
        # Load inventory
        self.inventory = self.load_inventory()
        
        if RICH_AVAILABLE:
            self.console = Console()
    
    def load_inventory(self):
        """Load inventory data."""
        if self.inventory_file.exists():
            try:
                with open(self.inventory_file, 'r') as f:
                    return json.load(f)
            except:
                return []
        return []
    
    def get_pending_count(self):
        """Count pending images in scan directory."""
        return len(list(self.scan_dir.glob("*.jpg")) + 
                  list(self.scan_dir.glob("*.jpeg")) + 
                  list(self.scan_dir.glob("*.png")))
    
    def get_rarity_distribution(self):
        """Get distribution of card rarities."""
        distribution = {}
        for card in self.inventory:
            rarity = card.get('rarity', 'Unknown')
            distribution[rarity] = distribution.get(rarity, 0) + 1
        return distribution
    
    def get_valuable_cards(self):
        """Get high-value cards (based on rarity and variants)."""
        valuable = []
        high_value_rarities = ['Secret Rare', 'Ultra Rare', 'GX', 'EX', 'V', 'VMAX', 'VSTAR']
        
        for card in self.inventory:
            is_valuable = False
            
            # Check rarity
            if card.get('rarity') in high_value_rarities:
                is_valuable = True
            
            # Check variants
            variants = card.get('variant_flags', {})
            if variants.get('first_edition') or variants.get('shadowless'):
                is_valuable = True
            
            if is_valuable:
                valuable.append(card)
        
        return valuable
    
    def monitor_simple(self):
        """Simple monitoring display (no rich library)."""
        while True:
            os.system('clear' if os.name == 'posix' else 'cls')
            
            print("=" * 60)
            print("CARDMINT MONITOR - FEDORA SCANNER")
            print("=" * 60)
            
            # Reload inventory
            self.inventory = self.load_inventory()
            
            # Statistics
            print(f"\n📊 STATISTICS:")
            print(f"  Total Cards: {len(self.inventory)}")
            print(f"  Pending Scans: {self.get_pending_count()}")
            print(f"  Session Time: {datetime.now() - self.stats['session_start']}")
            
            # Rarity distribution
            print(f"\n💎 RARITY DISTRIBUTION:")
            distribution = self.get_rarity_distribution()
            for rarity, count in sorted(distribution.items()):
                bar = "█" * min(count, 20)
                print(f"  {rarity:15} {count:3} {bar}")
            
            # Recent cards
            if self.inventory:
                print(f"\n🎴 RECENT CARDS:")
                for card in self.inventory[-5:]:
                    confidence = card.get('confidence', 0)
                    conf_indicator = "🟢" if confidence > 0.8 else "🟡" if confidence > 0.6 else "🔴"
                    print(f"  {conf_indicator} {card.get('name', 'Unknown'):20} "
                          f"{card.get('set_name', ''):15} "
                          f"{card.get('number', ''):8} "
                          f"{confidence:.1%}")
            
            # Valuable cards
            valuable = self.get_valuable_cards()
            if valuable:
                print(f"\n⭐ HIGH VALUE CARDS ({len(valuable)}):")
                for card in valuable[:5]:
                    variants = []
                    vf = card.get('variant_flags', {})
                    if vf.get('first_edition'):
                        variants.append("1st Ed")
                    if vf.get('shadowless'):
                        variants.append("Shadowless")
                    variant_str = f" [{', '.join(variants)}]" if variants else ""
                    
                    print(f"  💰 {card.get('name', 'Unknown'):20} "
                          f"{card.get('rarity', ''):12} "
                          f"{variant_str}")
            
            print("\n" + "=" * 60)
            print("Press Ctrl+C to exit | Refreshing every 5 seconds...")
            
            time.sleep(5)
    
    def monitor_rich(self):
        """Rich monitoring display with advanced UI."""
        def generate_display():
            # Reload inventory
            self.inventory = self.load_inventory()
            
            # Create layout
            layout = Layout()
            layout.split_column(
                Layout(name="header", size=3),
                Layout(name="body"),
                Layout(name="footer", size=3)
            )
            
            # Header
            header = Panel(
                f"[bold cyan]CARDMINT MONITOR[/bold cyan] - Fedora Scanner\n"
                f"Session: {datetime.now() - self.stats['session_start']}",
                style="bold white on blue"
            )
            layout["header"].update(header)
            
            # Body with two columns
            layout["body"].split_row(
                Layout(name="left"),
                Layout(name="right")
            )
            
            # Left panel - Statistics
            stats_table = Table(title="📊 Statistics", show_header=False)
            stats_table.add_column("Metric")
            stats_table.add_column("Value", style="cyan")
            
            stats_table.add_row("Total Cards", str(len(self.inventory)))
            stats_table.add_row("Pending Scans", str(self.get_pending_count()))
            
            # Calculate average confidence
            if self.inventory:
                avg_conf = sum(c.get('confidence', 0) for c in self.inventory) / len(self.inventory)
                stats_table.add_row("Avg Confidence", f"{avg_conf:.1%}")
            
            # Rarity table
            rarity_table = Table(title="💎 Rarity Distribution")
            rarity_table.add_column("Rarity")
            rarity_table.add_column("Count", style="yellow")
            rarity_table.add_column("Graph")
            
            distribution = self.get_rarity_distribution()
            max_count = max(distribution.values()) if distribution else 1
            
            for rarity, count in sorted(distribution.items()):
                bar_length = int((count / max_count) * 20)
                bar = "█" * bar_length
                rarity_table.add_row(rarity, str(count), f"[green]{bar}[/green]")
            
            layout["body"]["left"].split_column(
                Layout(Panel(stats_table)),
                Layout(Panel(rarity_table))
            )
            
            # Right panel - Recent cards
            recent_table = Table(title="🎴 Recent Cards")
            recent_table.add_column("Name", style="bold")
            recent_table.add_column("Set")
            recent_table.add_column("Number")
            recent_table.add_column("Confidence")
            
            for card in self.inventory[-10:]:
                confidence = card.get('confidence', 0)
                conf_color = "green" if confidence > 0.8 else "yellow" if confidence > 0.6 else "red"
                recent_table.add_row(
                    card.get('name', 'Unknown'),
                    card.get('set_name', ''),
                    card.get('number', ''),
                    f"[{conf_color}]{confidence:.1%}[/{conf_color}]"
                )
            
            # Valuable cards
            valuable = self.get_valuable_cards()
            valuable_table = Table(title=f"⭐ High Value Cards ({len(valuable)})")
            valuable_table.add_column("Name", style="bold yellow")
            valuable_table.add_column("Rarity")
            valuable_table.add_column("Variants")
            
            for card in valuable[:5]:
                variants = []
                vf = card.get('variant_flags', {})
                if vf.get('first_edition'):
                    variants.append("1st")
                if vf.get('shadowless'):
                    variants.append("Shadow")
                variant_str = ", ".join(variants) if variants else "-"
                
                valuable_table.add_row(
                    card.get('name', 'Unknown'),
                    card.get('rarity', ''),
                    variant_str
                )
            
            layout["body"]["right"].split_column(
                Layout(Panel(recent_table)),
                Layout(Panel(valuable_table))
            )
            
            # Footer
            footer = Panel(
                "[dim]Press Ctrl+C to exit | Auto-refresh every 2 seconds[/dim]",
                style="dim white"
            )
            layout["footer"].update(footer)
            
            return layout
        
        # Live display
        with Live(generate_display(), refresh_per_second=0.5, console=self.console) as live:
            try:
                while True:
                    time.sleep(2)
                    live.update(generate_display())
            except KeyboardInterrupt:
                pass
    
    def run(self):
        """Run the monitor."""
        try:
            if RICH_AVAILABLE:
                self.monitor_rich()
            else:
                self.monitor_simple()
        except KeyboardInterrupt:
            print("\n\nMonitor stopped.")
            sys.exit(0)

def main():
    """Main entry point."""
    monitor = CardMintMonitor()
    monitor.run()

if __name__ == "__main__":
    main()