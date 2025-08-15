---
name: Bug report
about: Create a report to help us improve
title: ''
labels: ''
assignees: ''

---

**Describe the bug**
  A clear and concise description of what the bug is.

  **To Reproduce**
  Steps to reproduce the behavior:
  1. Start CardMint with command '...'
  2. Trigger capture/scan with '...'
  3. Process card type '...'
  4. See error

  **Expected behavior**
  A clear and concise description of what you expected to happen.

  **Actual behavior**
  What actually happened instead (include error messages if any).

  **Screenshots/Images**
  If applicable, add screenshots or sample card images that trigger the issue.

  **Environment (please complete the following information):**
   - OS: [e.g. Ubuntu 22.04, Fedora 42]
   - Node Version: [e.g. 20.0.0]
   - CardMint Version: [e.g. v1.0-alpha]
   - Camera Model: [e.g. Sony ZV-E10M2, or "Mock Camera" if using simulation]
   - Database: [e.g. PostgreSQL 16, Redis 7.2]
   - GPU Available: [Yes/No, model if Yes]

  **Configuration:**
   - Processing Mode: [e.g. Real-time, Batch]
   - OCR Service: [e.g. PaddleOCR, Mock OCR]
   - API Services Working: [PriceCharting: Yes/No, Pokemon TCG: Yes/No]
   - Worker Count: [e.g. 20]

  **Logs:**
  Paste relevant error logs here
  Include correlation IDs if available

  **Card Details (if applicable):**
   - Card Name: [e.g. Pikachu]
   - Set: [e.g. Base Set]
   - Card Number: [e.g. 58/102]
   - Special Features: [e.g. Holo, 1st Edition, Promo]
   - Confidence Score: [e.g. 0.85]

  **Performance Metrics (if relevant):**
   - Capture Time: [e.g. 35ms]
   - Processing Time: [e.g. 8s]
   - OCR Confidence: [e.g. 0.92]
   - Overall Pipeline Accuracy: [e.g. 0.97]

  **Additional context**
  Add any other context about the problem here, such as:
  - Frequency of occurrence
  - Specific card types affected
  - Network conditions
  - Recent configuration changes

  This template is specifically tailored for CardMint with:
  - Card-specific reproduction steps
  - Camera and processing configuration details
  - Card identification metrics
  - Performance measurements relevant to the 99.9% accuracy target
  - API service status checks
  - OCR and confidence scoring information
