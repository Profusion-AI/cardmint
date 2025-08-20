Cardmint Optimizations

\# \*\*Optimizing CardMint’s Scanning and ML Pipeline\*\*

\#\# \*\*Overview of the Proposed Workflow\*\*

To achieve a fast, cost-effective card scanning workflow, we will split responsibilities between the two machines and use local resources instead of cloud services whenever possible. The \*\*Fedora Linux machine\*\* will handle image capture (since the Sony camera SDK works reliably there), while the \*\*MacBook Pro (MBP)\*\* will perform the heavy machine learning (ML) tasks like card identification. This division leverages the MBP’s 24 GB unified memory and Apple GPU for speed, and frees the Fedora machine to keep capturing images without slowdown. All high-resolution images and inventory data will be stored locally on the MBP to avoid cloud storage costs. Below is a more detailed plan addressing each aspect of the pipeline:

\- \*\*Image Capture (Fedora)\*\* – Use the Fedora machine which has a Sony ZV-E10M2 attached via USB-C for manual card photography, one card at a time, with stable Sony SDK support. Save images locally on Fedora immediately after capture.  
      
\- \*\*Local Storage vs. Cloud DB\*\* – Avoid uploading large images to the cloud (e.g. Fly.io Postgres) to save on bandwidth and storage fees. Instead, transfer and store images and inventory info on the MBP’s local database/storage. This keeps costs low and speeds up access.  
      
\- \*\*ML Processing (MBP)\*\* – Offload computational tasks like image recognition to the MBP. The MBP will run the card identification model (leveraging Apple Silicon’s GPU/Neural Engine for acceleration) to quickly and accurately identify each card from the photo .  
      
\- \*\*Real-Time Identification\*\* – Integrate the MBP’s ML output back into the Fedora machine’s UI for on-the-fly verification. The goal is a \*\*\~3–5 second\*\* turnaround per card (from snap to identification), enabling a rapid scan flow.  
      
\- \*\*Networking & Communication\*\* – Establish a local network communication channel between Fedora and MBP so they can exchange images and results seamlessly (e.g. via an HTTP API or network shared drive). Both machines are on the same LAN, so this can be done with minimal latency and no cloud dependency.  
      
\- \*\*Inventory Management\*\* – Use a local database on the MBP to log each scanned card’s details (name, set, etc.) and possibly a reference to its image. High-quality images will be retained on local disk for future use (customer viewing, ML training, etc.), but we’ll avoid storing them in an expensive remote DB for now.  
    

By leveraging the strengths of each device and keeping data local, this plan aims to maximize throughput and accuracy without incurring unnecessary cloud costs.  
\#\# \*\*1. Image Capture on Fedora (Stable Sony SDK Setup)\*\*

The Fedora Linux machine will serve as the \*\*capture station\*\* for photographing cards. This is primarily because the Sony camera’s SDK is confirmed to work reliably on Fedora (after significant troubleshooting on the MBP, the Linux environment proved to be the stable solution). We will not disturb this working setup. Key considerations for this stage:

\- \*\*Manual one-by-one capture:\*\* You will place each card under the camera and trigger the capture via the Fedora machine (using the Sony SDK interface). Each card’s photo will be captured individually. While this is manual, it ensures careful handling and positioning of valuable cards.  
      
\- \*\*Ensure image quality:\*\* Good lighting and focus are essential. High-quality, well-lit images are crucial for both accurate ML identification and for showing to customers later. In fact, clear images can enable ML models to reach \~85–95% identification accuracy, whereas poor lighting or card wear can significantly degrade the accuracy . Setting up consistent lighting (e.g. a light box or desk lamps) and using a fixed camera mount/tripod will yield uniform, clear photos.  
      
\- \*\*Local saving on Fedora:\*\* Save each captured image to a designated folder on the Fedora machine’s local drive (for example, \~/card\_scans/raw/). This provides a temporary holding area for new images. Filenames can be timestamped or numbered sequentially to keep them unique (e.g. card\_2025-08-20\_001.jpg). Saving to SSD storage on Fedora is fast (nearly instant) and won’t bottleneck the capture process.  
      
\- \*\*Image format and resolution:\*\* Capture at high resolution (since one of your value propositions is to show detailed card images to buyers). A high-res JPEG or PNG (rather than RAW) might be preferred – JPEG will be much smaller file size with minimal quality loss if high quality setting is used, which speeds up transfer and storage. You likely don’t need huge RAW files for identification or web display, so a high-quality JPEG (with all card details visible when zoomed) is a good balance. This will keep each file perhaps in the few MBs range rather than tens of MBs, easing the pipeline load.  
      
\- \*\*Initial processing (if needed):\*\* If the captured image has background beyond the card or needs rotation, the Fedora side can do a light preprocessing step. For example, using OpenCV or PIL to auto-crop the card if the background is a contrasting color. However, if the card is consistently placed and fills most of the frame, this may not be necessary. We can rely on the ML model to handle any minor scaling issues, or do a simple center-crop. The priority is to keep Fedora’s work minimal to maintain speed.  
    

  

By keeping all capture tasks on Fedora, we utilize the setup that’s already working and avoid any further SDK compatibility issues on Mac. The Fedora machine (16 GB RAM) will primarily be I/O-bound (capturing and saving images) which it can handle easily, rather than CPU-bound with ML. This separation ensures the camera pipeline remains smooth regardless of heavy ML processing happening elsewhere.

  

\#\# \*\*2. Local Storage vs. Cloud Database for Images and Inventory\*\*

  

Instead of uploading images or inventory data to a cloud database (such as the Fly.io Postgres DB you mentioned), we will manage these locally on the MBP. This approach is both \*\*cost-efficient and fast\*\*:

\- \*\*Avoiding cloud costs:\*\* Storing high-resolution images in a cloud database or storage service could incur significant costs (both in storage fees and data transfer, especially if you have thousands of cards). By keeping images on the MBP’s 1 TB SSD (and/or the 1 TB external NVMe), you essentially use “free” storage that you already have. This avoids running up a bill on cloud services just for image storage.  
      
\- \*\*Local inventory database:\*\* The MBP can run a local database (for example, a lightweight SQLite file or a small MySQL/Postgres instance) to keep track of your inventory. This database would store \*\*metadata\*\* for each card – e.g. card name, set, edition, condition rating, and file path to the image on disk. The actual images can remain as files on the filesystem rather than BLOBs in the DB, which is generally more efficient. The Fedora capture process (or the MBP processing service) can insert a record into this DB for each new card as it’s identified. Because this DB is local, reads/writes will be very fast, and there’s no network latency or API calls to slow down the pipeline.  
      
\- \*\*High-res image retention:\*\* Even though high-quality photos aren’t strictly required for the identification algorithm (which could work with lower-res images), \*\*we will retain them for business purposes.\*\* Your strategy is to provide customers a detailed image of each card they might buy – essentially a digital “close inspection.” Keeping these photos is valuable for e-commerce: it builds buyer trust and showcases card conditions. Since we’re not paying for cloud storage, there’s little downside to saving them locally. Over 1,000+ cards, this could consume tens of gigabytes (if each image is a few MB), but your MBP’s 1 TB can handle it. We can also periodically offload older images to the external 1 TB NVMe as backup if needed.  
      
\- \*\*Thumbnail generation (optional):\*\* For the web-based UI or eventual e-commerce site, you might not always need to load the full high-res image. We could generate a smaller thumbnail version for quick viewing in the UI, while keeping the high-res version for detail or zoom viewing. This is optional but can make the UI snappier. These thumbnails (say 300px or 500px in size) could be stored alongside the originals.  
      
\- \*\*Minimize remote DB usage:\*\* We’ll use the remote Fly.io DB either very sparingly or not at all in this phase. If you already have it set up for something (like price data or other metadata), we can still query it for reference information if needed. But for storing our own inventory records and images, the \*\*MBP will act as the “server”\*\*. This not only saves money, but also avoids the latency of sending data to a remote location and then fetching it when needed. All identification and inventory tracking can be done within your local network.  
      
\- \*\*Backup strategy:\*\* Relying on local storage means we should plan for backups to protect against drive failure or data loss. You can use the 1 TB Thunderbolt 3 NVMe drive as a backup device. For example, at the end of each day of scanning, copy the new images and an export of the inventory database to the external drive. This way you have an offline backup of all your work. This doesn’t involve cloud costs and ensures you don’t lose data in case something happens to the MBP. Alternatively, you could set up an automated backup to a NAS or even a cloud cold-storage (like Amazon Glacier) later on, but that’s optional and can be done once volume grows.  
    

  

By keeping data local (on the MBP and external drive), we dramatically reduce external dependencies. This approach is \*\*more cost-efficient and faster\*\* than constantly interacting with a cloud DB. Only once your sales platform is up and you need to serve images to customers might you consider a cloud storage (or a CDN) for hosting the images, but until then, local storage suffices. Even when that time comes, you could batch upload only the images of cards you’re listing for sale to a cloud storage, rather than everything, to control costs.

  

\#\# \*\*3. Offloading ML Processing to the MacBook Pro\*\*

  

Offloading the computational heavy lifting to the MBP is central to achieving the desired speed. The MBP’s Apple Silicon (with 24 GB unified RAM) is well-suited for ML tasks – it has a powerful GPU and a Neural Engine that can accelerate machine learning inference. Here’s how we’ll integrate the MBP into the pipeline for card identification:

\- \*\*Why MBP for ML:\*\* The Fedora machine has 16 GB RAM and presumably a less powerful GPU/CPU. Running complex vision models there, especially in quick succession, could bog it down. In contrast, Apple’s M1/M2 chips can achieve \*\*1–3 second inference times for each card image\*\* when using an optimized model . Also, GPU acceleration provides a \*\*5×–10× speedup\*\* over CPU-only processing . By utilizing the MBP’s GPU, we ensure that identification is fast enough to keep up with scanning.  
      
\- \*\*Model deployment on MBP:\*\* Once your custom model is trained (the one currently “in the oven”, expected by Aug 21), we will deploy it on the MBP for inference. This could be a PyTorch model running on Apple’s \*\*MPS\*\* (Metal Performance Shaders) backend, or converted to \*\*Core ML\*\* format to leverage the Neural Engine for even faster performance. The optimal approach, as identified in your research, is to use a model like \*\*SmolVLM-500M\*\* fine-tuned on the card dataset, and convert it for efficient Apple Silicon execution . Apple M2 hardware has shown it can handle such models within a few seconds per image using 2–4 GB of memory , which is well within your MBP’s capacity. In fact, the MLX framework benchmarks indicate \~2–5 seconds per card on an M1, and under 1 second on future M-series, so your M2 should be comfortably in the 1–3 second range with the right optimizations .  
      
\- \*\*Persistent inference service:\*\* To avoid the overhead of loading the model for each image, the MBP will run a persistent \*\*inference service\*\*. This means the model will be loaded into memory once, and then kept alive to process many images sequentially. This could be a custom Python script or server that awaits image input. By doing so, we eliminate the startup time per image (model initialization can take many seconds if done repeatedly ). The service will have the model warm and ready to handle a stream of images with minimal delay between them.  
      
\- \*\*Communication mechanism:\*\* We need a way to send images from Fedora to the MBP’s inference service and get back results. Two practical options to implement this are:  
      
    1\. \*\*HTTP API:\*\* Set up a lightweight web server on the MBP (using Flask or FastAPI in Python, for instance) with an endpoint like /identify. When a new card image is captured, Fedora can send an HTTP POST request to this endpoint, including the image (either as a file upload or as raw bytes). The MBP server, upon receiving the image, runs the model to identify the card, and responds with the identification result (e.g. the card’s name/set, etc., likely in JSON). The Fedora side script/UI can then parse this result and display it. This method is relatively straightforward to implement and leverages the network. On a local network, an HTTP call with an image payload of a few MB should be very fast (tens of milliseconds to maybe 0.1–0.2s on Wi-Fi, less on Ethernet). The overall latency will be dominated by the model inference time, not the network transfer.  
          
    2\. \*\*Network-shared folder (SMB/NFS):\*\* Alternatively, you can share a folder on the MBP to the network and mount it on the Fedora machine. Fedora would then \*\*save the captured image directly to that network-mounted folder\*\* (which actually writes it to the MBP’s disk). The MBP can run a monitoring script that watches this folder for new files (e.g. using file system events or polling every second). As soon as a new image file appears, the MBP script processes it and could output a result file (such as a text file with the identified name, or an entry in the database). The Fedora UI could then either poll for that result or be notified when it’s ready. This approach avoids explicitly sending data through an API, and instead uses the filesystem as the handshake mechanism.  
          
      
    Both approaches can work; the \*\*HTTP API approach\*\* is often easier to manage for a request/response cycle (Fedora sends image → waits for reply → gets result), which fits well with interactive scanning. We’ll proceed with that for clarity, but know that the SMB share approach is an alternative if for some reason an HTTP server is undesirable.  
      
\- \*\*Networking setup:\*\* Since both machines are on the same network, ensure that they can see each other (know each other’s IP or hostname). You might assign a static IP or local hostname to the MBP for convenience (or use something like mbp.local if mDNS/Bonjour is enabled, which Macs support). Make sure the MBP’s firewall allows incoming connections on whatever port the API will run (e.g. port 5000 for Flask, or you can use port 80/8000 etc.). On the Fedora side, you’ll need to install a library to send HTTP requests (Python’s requests is great if your UI is in Python). On the MBP side, the Flask/FastAPI server will use little resources and can run alongside your model.  
      
\- \*\*Batch vs real-time processing:\*\* We are aiming for real-time (one-by-one) processing so you can verify each card as you go. However, note that you \*\*do\*\* have an alternative if ever needed: batch processing. Because you have a 1 TB external NVMe, you could theoretically scan a batch of, say, 100 cards on Fedora (saving all images locally), then copy that batch to the MBP (via the external drive or network) and process them in one go. This might be useful if you ever needed to operate the camera completely stand-alone for speed and do identification later. But the downside is you lose the immediate feedback per card. Given that part of your process is “light manual verification” of each identification, it’s better to do it in real-time. Batch processing is there as a backup or for situations like training new models on a large set of images, etc. We’ll optimize for real-time interactive use.  
      
\- \*\*Cost considerations:\*\* All ML processing on the MBP is local – there’s no cost per inference (unlike using a cloud API which might charge per image or per month). For instance, \*\*Ximilar’s commercial API\*\* boasts \~97% accuracy and \~1 second processing, but requires a paid plan for high volume . By using your own model on the MBP, you avoid those fees entirely while still getting comparable performance. Essentially, you’re investing computing power instead of money – since you already have the hardware, each additional image is “free” to process.  
    

  

By offloading to the MBP, we ensure the Fedora machine remains free to handle the camera and UI tasks without lag. The MBP, meanwhile, can fully utilize its powerful hardware to run the identification model quickly. This separation is key to achieving throughput on the order of one card every few seconds.

  

\#\# \*\*4. Integrating Identification Results into the Workflow\*\*

  

With the MBP handling identification, we need to feed those results back into your system so they’re recorded and visible to you in real time:

\- \*\*Fedora UI modification:\*\* You mentioned having a \*\*web-based review UI\*\* on the Fedora laptop that you built (with the help of Claude Code). We will integrate the MBP’s results into this UI. Likely, the UI currently shows the captured image and maybe a placeholder or basic info. We will add a step where after an image is captured:  
      
    1\. The Fedora app sends the image to the MBP service (as described above).  
          
    2\. It then waits for the response (or polls for a result).  
          
    3\. Once the result (card identification) is received, the UI displays the proposed card name/set to the user for verification.  
          
    4\. The user can then confirm it or correct it if the model was wrong (e.g. if the model was 90% sure but picked the wrong edition or misidentified a very similar card, you can override it).  
          
    5\. After confirmation, the card’s data (and image path) are saved to the inventory DB.  
          
      
    The UI flow might need a small adjustment to accommodate a short wait time (a few seconds) for the identification step. For example, showing a spinner or “Identifying…” message after capture could be a good UX improvement so you know the system is working on it.  
      
\- \*\*Incorporating the fine-tuned model data:\*\* Right now, you noted the identification isn’t very accurate because it’s not yet leveraging your specialized model or corpus. Once your custom model (possibly a SmolVLM fine-tuned on TheFusion21 Pokemon card dataset) is ready on the 21st, we’ll plug it into the MBP service. This should drastically improve accuracy because it will have learned from a large corpus of card images and metadata. The TheFusion21 dataset includes \~13k high-res card images with labels and metadata , which provides a solid foundation. Community results show that with such data, models can achieve high accuracy (often in the 85–95% range as mentioned) and even up to 97% in ideal cases . So we can expect the MBP model to start identifying most cards correctly, especially standard ones.  
      
\- \*\*Handling identification uncertainty:\*\* There will be cases where the model isn’t 100% confident or might produce the wrong identification. We can optimize the UI for this scenario:  
      
    \- If possible, have the model return a \*\*confidence score\*\* or top-N predictions. For example, it might say “90% sure this is Pikachu (Base Set), 8% it’s Pikachu (Shadowless), 2% something else.” The UI could then display the top suggestion by default but also allow you to see alternatives in a dropdown. This way, if the top guess is slightly off (e.g. the model couldn’t tell if it’s 1st Edition vs Unlimited), you can quickly pick the correct one from the list rather than manually typing everything.  
          
    \- Implement \*\*human-in-the-loop\*\* logic: if the model’s confidence is below a certain threshold or if it gives multiple close matches, flag it for manual review. (In practice, since you’ll be verifying each one anyway, this just means you pay extra attention if something seems off). Academic research and community tools often use this strategy of only requiring human confirmation for low-confidence cases .  
          
      
\- \*\*Recording the data:\*\* Once verified, the identified card’s details can be saved. The MBP could directly insert into the inventory DB (if the MBP service is aware of the DB). Alternatively, the Fedora side can take the confirmed info and make a call to the database (since the DB will be hosted on the MBP, Fedora could connect over the network or via the API to add a record). Either approach works; a straightforward way is:  
      
    \- MBP service returns the card info to Fedora.  
          
    \- Fedora app, upon user confirmation, calls a simple API on MBP to add the record (or directly writes to a shared database connection).  
          
      
    If using an API approach, the MBP’s Flask server could have another endpoint for adding an inventory record (or we could just have the identification endpoint itself create the DB entry immediately, then Fedora just refreshes its list).  
      
\- \*\*Keeping the UI responsive:\*\* We should ensure the identification step doesn’t freeze the UI. If the UI is a web front-end or a simple script, consider making the request to MBP \*\*asynchronous\*\* (non-blocking) with a callback or using a separate thread. But since the identification is at most a couple seconds, a simple wait with a loading indicator is user-friendly enough. The key is that the Fedora machine isn’t doing the heavy work, so it won’t become unresponsive – it’s just waiting on network IO for a moment.  
      
\- \*\*Testing and calibration:\*\* Once integrated, do a few test runs. Scan a variety of cards and see how the model performs. This will let you calibrate any adjustments needed (for instance, if the model often confuses two particular cards, you might add some rule or pay attention to that scenario).  
    

  

The goal is that after capture, \*\*the UI immediately shows the image and within seconds shows the identified card name/set\*\*, which you can accept or correct. This tight feedback loop will let you scan through cards quickly while maintaining accuracy.

  

\#\# \*\*5. Performance Optimization for High-Throughput Scanning\*\*

  

To meet the target of scanning thousands of cards at \~3–5 seconds per card, we need to optimize each step of the pipeline. Here’s how the above design supports that, and additional tweaks to consider:

\- \*\*Parallelism and pipelining:\*\* By splitting work between two machines, we introduce a form of parallelism. The moment Fedora finishes capturing an image and sends it off to the MBP, Fedora is technically free to begin setting up the next card. In practice, you’ll likely wait a second or two for the identification to display (so you can verify it before moving on). But effectively, while the MBP is crunching the image, you can already be removing the previous card and placing the next one. This overlap means the ML processing time is “hidden” behind your manual card handling time.  
      
\- \*\*MBP processing speed:\*\* The custom model on the MBP should be as optimized as possible. Using an \*\*optimized neural network\*\* will get inference times in the sub-1-second range for each card on a GPU . If your model is larger and takes a couple of seconds, that’s still fine. What we want to avoid is something like an OCR-based approach that might take \~12 seconds per image – and indeed we are avoiding that by using the fine-tuned model. If needed, consider techniques like:  
      
    \- Model quantization or using a smaller variant if speed is more critical than a few points of accuracy.  
          
    \- Only processing a region of interest (ROI) of the image. Since the card likely occupies most of the photo, this isn’t a big issue, but if your image has a lot of background, cropping to the card edges first can reduce the pixels the model has to process.  
          
    \- Ensure the MBP is running in \*\*performance mode\*\* (on macOS, make sure “Low Power Mode” is off, and ideally the MBP is plugged into power so it doesn’t throttle).  
          
    \- Use the \*\*Metal GPU (MPS)\*\* backend (which PyTorch uses with device='mps') or convert to a Core ML model to utilize the Apple Neural Engine. As noted, Apple’s hardware plus optimized frameworks can achieve inference in 1–3 seconds easily for moderate-size models .  
          
      
\- \*\*Fedora resource usage:\*\* The Fedora machine should have minimal load besides the camera and web UI. 16 GB RAM is plenty for capturing images and running a web interface. Avoid running any training or heavy processes on it while scanning. Also, monitor CPU usage during captures – if the Sony SDK uses significant CPU, just be mindful not to overload with other tasks. The design ensures Fedora doesn’t need to do ML, which would be the main source of slowdown.  
      
\- \*\*Throughput calculation:\*\* At \~5 seconds per card (worst case), you can scan 12 cards per minute. That’s 720 cards per hour. Realistically, with minor pauses and verification, you might do around 500/hour sustained. Over a typical workday, that’s thousands of cards, which is likely sufficient for your needs. If identification was slower (say 10+ seconds each), the throughput would drop and scanning “thousands” would become impractical without many hours of work. That’s why this optimized pipeline is critical.  
      
\- \*\*Networking speed:\*\* Ensure your local network is fast. Ideally, use a \*\*wired Gigabit Ethernet\*\* connection between the machines (or both connected to the same Gigabit router). This makes the image transfer virtually instantaneous (a 5 MB image will transfer in \~0.05s on gigabit). If wired isn’t possible, a modern Wi-Fi (802.11ac or Wi-Fi 6\) network is usually fine for these file sizes, but try to have both machines relatively close to the router to avoid any Wi-Fi latency spikes. In testing, if you find the image POST takes more than a fraction of a second, that might be a network issue to iron out.  
      
\- \*\*Concurrent scanning considerations:\*\* Right now, you’re scanning manually one card at a time, which this setup handles well. If you ever tried to scale up to using multiple cameras or scanning multiple cards at once (batch on a flatbed scanner, etc.), you would need to extend the pipeline to queue up tasks. But as per your current approach (one card, one camera), a simple request-response per image is sufficient and easier to manage.  
    

  

In summary, the combination of \*\*Fedora for capture \+ MBP for accelerated ML inference \+ efficient local transfer\*\* ensures that each cycle of scan-and-ID is only a few seconds. This meets the requirement for high-volume scanning without overwhelming either system. Testing and minor tuning (as mentioned above) will get you reliably in the 3–5 second range per card, even accounting for brief human verification.

  

\#\# \*\*6. Networking and Communication Between Fedora and MBP\*\*

  

Establishing a robust communication channel between the two machines is crucial. Since they are on the same network, we have a few straightforward options to enable them to “talk” to each other:

\- \*\*HTTP API method (recommended):\*\* Run a small web server on the MBP that exposes endpoints for the needed actions (at minimum, an /identify endpoint to handle image recognition requests). You can use Python’s Flask or FastAPI:  
      
    \- The server will listen on a specific port (say 5000\) and accept requests from the local network. (Double-check MBP’s firewall settings; on macOS, when you first run a Flask app it might prompt to allow incoming connections, which you should permit or adjust in System Preferences \> Security \> Firewall).  
          
    \- The Fedora machine, upon capturing an image, will send an HTTP POST to the MBP. This can be done in Python using the requests library, or any HTTP client. The POST will include the image file. One convenient way is to send it as form-data with a file field (so you don’t have to manually encode it). Another is to base64 encode the image and send a JSON, but that’s not really necessary – sending the binary is fine.  
          
    \- The MBP server receives the image, processes it through the loaded model, then returns the result. You can define what the result contains – e.g. a JSON with fields like "name": "Pikachu", "set": "Base Set", "confidence": 0.95, etc. Keep it simple for now, maybe just the name or an array of possible names.  
          
    \- On the Fedora side, capture the response and use it in the UI.  
          
    \- This request-response cycle over HTTP is easy to test with tools like curl as well. And since it’s all internal network, it’s secure (not exposed to the internet) and fast. There’s negligible overhead beyond the image transfer. (For context, even commercial card recognition APIs use HTTP/REST – e.g., Ximilar’s API is a REST API that processes images in \~1s over the internet , so locally we can definitely do it faster).  
          
      
\- \*\*Shared folder method:\*\* If you prefer not to set up an HTTP server, you could use the file-system approach:  
      
    \- On the MBP, share a folder (System Preferences \> Sharing \> enable File Sharing, and add a folder, granting access to a user account).  
          
    \- Mount this folder on Fedora (using CIFS/SMB mount). For instance, Fedora can mount //MBP\_IP/SharedFolder to a local mount point (and use credentials of your Mac user).  
          
    \- When Fedora captures an image, save it directly to this mount (which means it’s actually saving over the network to MBP’s disk). Then perhaps create a small flag file or simply rely on file name conventions to indicate a new file is ready.  
          
    \- Run a script on MBP that continuously watches that directory. On Linux, inotify is used; on Mac, you could use fswatch or Python’s watchdog. Alternatively, poll the directory every second for new files.  
          
    \- When a new image file appears, the MBP processes it and then could write the result maybe as a text file or update a database entry.  
          
    \- Fedora’s UI would then need to pick up that result (either by noticing the new text file or checking the DB).  
          
      
    This approach can work, but it’s a bit more convoluted to synchronize timing. There could be a slight delay in network file syncing. An HTTP request inherently carries the “new image” and gives you a response, which is a cleaner transaction. Therefore, the HTTP method is generally preferable for its simplicity.  
      
\- \*\*Serial/USB or other methods:\*\* You had mentioned the idea of machines talking via serial/monitor. Given both machines are full-fledged computers on a network, a serial link isn’t necessary (and would actually be much slower than gigabit ethernet). We can safely rely on networking – either Ethernet or Wi-Fi – to handle all communication. It’s more standard and allows using high-level protocols like HTTP which have lots of existing support. No need for a specialized serial connection between them in this setup.  
      
\- \*\*Error handling and timeouts:\*\* Whichever method is used, incorporate basic error handling. For example, if Fedora sends an image and doesn’t get a response in, say, 10 seconds (which shouldn’t usually happen if things are working, but just in case the MBP service crashed), have it timeout and maybe retry or alert you. Likewise, the MBP service should handle cases like receiving a corrupted image or being unable to identify (it can return an “error” status or message). These are edge cases, but planning for them will make the system more robust for long scanning sessions.  
      
\- \*\*Security (local):\*\* Since this is all on a trusted LAN, you don’t have to worry too much about securing the API with authentication, etc., as long as your network is private. If there’s any concern, you could restrict the MBP server to only accept from the Fedora’s IP. But typically for a home/office LAN with just your machines, it’s fine open. (Do ensure your Wi-Fi is secure so no one else is snooping; standard practice).  
      
\- \*\*Testing the connection:\*\* Before integrating into the UI, test the communication with a simple dummy call. For instance, start the MBP server with a test route that just returns “Hello”. From Fedora, use curl or a small script to hit that and see that you get a response. Then test sending a small image file and getting a dummy response. This will flush out any networking issues early (like firewall or name resolution problems) so that by the time you plug it into the main pipeline, you know the pipe works.  
    

  

By implementing a solid network communication layer (preferably the HTTP-based service), we enable real-time collaboration between the two machines. This is the backbone that allows Fedora and MBP to function as a single system (capture station \+ brain), which is essential for our pipeline.

  

\#\# \*\*7. Utilizing the New ML Model and Data for Accuracy\*\*

  

Your MBP is currently training a model (due 21st Aug), which we presume is a fine-tuned vision model specifically for card identification. Making full use of this model and the existing card data will be crucial for accuracy:

\- \*\*Fine-tuned model (SmolVLM or similar):\*\* The model you’re training, possibly based on \*\*SmolVLM-500M with LoRA fine-tuning on TheFusion21/PokemonCards dataset\*\*, will be the centerpiece for identification. This model leverages both visual features and possibly textual cues (if it’s multimodal) to recognize cards. Since it’s trained on a large corpus of card images/names, it should be adept at recognizing card artwork and layouts. Once it’s ready, we will load this model in the MBP’s inference service. Expect a significant jump in accuracy compared to any off-the-shelf or smaller solution you might have been testing earlier. The community experiences suggest well-trained custom models can achieve in the upper 80s to 90+% accuracy , closing in on commercial API performance.  
      
\- \*\*Card variant and attribute identification:\*\* One challenge noted in the field is distinguishing between variants – e.g. 1st Edition vs Unlimited, Shadowless vs standard, or identifying the set symbol on the card . The model may or may not handle these perfectly, especially if the training data had gaps for those cases . Be prepared to supplement the model’s output with additional logic for these fine details:  
      
    \- For example, if the model outputs “Charizard Base Set” but there’s a 1st Edition stamp on the card that the model overlooked, you might catch that in the image by a small secondary detection model (like a tiny CNN or even an OpenCV template match to spot the “Edition” symbol). This could be a future improvement. In the short term, the manual verification step covers this – you will likely notice the stamp and can adjust the recorded data (maybe marking a field “Edition: 1st”).  
          
    \- Over time, if you find the model consistently misses a certain detail, we can address it by either further fine-tuning (including those cases in training) or by adding an auxiliary classifier for that attribute.  
          
      
\- \*\*OCR for textual data (optional):\*\* Some sellers also use OCR to read card text (like name or number) to help identification. Your fine-tuned model might already effectively do this internally (since VLMs can glean text if trained on captions). If needed, we could integrate an OCR engine (like Tesseract or EasyOCR) to read the card name or number from the image and cross-reference it with a database of card names. However, this will slow down processing (OCR can be relatively slow, and the analysis shows OCR-based pipelines take \~12s per card ). Since speed is a priority and you have a good model, we likely won’t need OCR now. It’s something to keep in mind if you ever need a secondary check for tough cases (e.g., extremely rare cards where you want to double-confirm by reading the text).  
      
\- \*\*Referencing a card database:\*\* Given that you want to ultimately have an e-commerce listing with card details, it might be useful to have a database of all possible cards (names, sets, etc.) to validate against. For instance, if the model returns a slightly off name that doesn’t exactly match a known card, you could correct spelling or formatting by looking it up. There are public databases for trading cards (like Pokémon or MTG card databases). In the case of Pokémon TCG, sources like the Pokémon TCG API or datasets like TheFusion21 already have structured info. We could integrate such data into your inventory system. For example, once a card name is identified, your system can automatically attach additional info like card number, year, etc., from a reference DB. This enhances your inventory records and what you can display to buyers (and it saves you typing those details).  
      
\- \*\*Testing the model’s limits:\*\* As you start using the model, pay attention to the failure modes:  
      
    \- Does it struggle if the card is slightly tilted or not perfectly flat? (If so, ensure you’re placing cards flat and maybe implement a slight rotation correction in software if needed).  
          
    \- Does it have trouble with holo/shiny cards due to glare? (Lighting diffusion might help here).  
          
    \- Is it confused by very similar artworks or reprints? (You might then need to include the set identification explicitly in the pipeline).  
          
      
    Knowing these will help you continuously improve the pipeline. The good news is that the \*\*community and commercial solutions have demonstrated that automated card identification is very viable\*\*, with some achieving over 97% accuracy for Pokémon cards . Your solution, being custom, can inch toward that with the right adjustments and data.  
    

  

In short, the MBP with the new model will act as the “brains” of Cardmint, leveraging the fine-tuned knowledge to tell you what each card is. This is the component that turns what was a simple image capture system into a smart, autonomous identification system. By integrating it tightly (and improving it with feedback), you’ll significantly reduce the manual effort needed per card, only intervening occasionally when the model isn’t certain.

  

\#\# \*\*8. Keeping Costs Low and Future Considerations\*\*

  

One of your key concerns is cost management while the project is in bootstrap phase. This design has been created with that in mind. Let’s recap the cost-saving measures and note some future upgrades when sales (and budget) increase:

\- \*\*Using existing hardware:\*\* We utilize the Fedora PC and MBP that you already own to their fullest extent. No need for renting cloud servers or buying new specialized equipment right now. The Apple Silicon in the MBP acts as a high-performance ML server at zero extra cost.  
      
\- \*\*Avoiding cloud APIs:\*\* While there are enterprise-grade solutions (Ximilar, TCGPlayer’s Scan, etc.) that could do this recognition, they either cost money or lock you into specific platforms . By building your own pipeline, you pay nothing per scan. This is important when scanning thousands of cards – API costs or subscription fees can add up quickly. Your only “cost” is electricity and your time. The former is negligible for a MBP, and the latter is saved by the efficiency of the system.  
      
\- \*\*Local database vs cloud DB:\*\* As discussed, we’re not paying for database hosting or big cloud storage. The Fly.io Postgres (if you used it heavily for images) could become expensive at scale; we avoid that. If you do use it for some metadata, the volume will be small (text data for card info), which is low-cost. The heavy data (images) stay off-cloud.  
      
\- \*\*Modular design for scaling:\*\* This pipeline is modular – capture, process, store are separate. In the future, if volume truly explodes and you have budget, you could scale out any piece:  
      
    \- For instance, add a second camera station (another Fedora machine or even get the MBP’s camera working if Sony SDK issues get resolved or a different camera) to double throughput. The MBP service could potentially handle images from both, maybe queuing them if needed, as long as they don’t come in faster than it can process (the MBP might handle 2-3 per second easily if the model is light).  
          
    \- Or, if the identification model needs to be even faster or more accurate, by then maybe Apple’s M3/M4 chips or an external GPU could be an option – but for now your M2 is more than sufficient.  
          
    \- If you decide to allow customers to see images online, you might invest in a small web server or use an existing e-commerce platform. You can still keep costs low by using free tiers or self-hosting initially. The images can be delivered via a simple website hosted perhaps on the MBP or a cheap cloud storage with pay-per-use (which at low traffic is pennies).  
          
      
\- \*\*Future ML possibilities:\*\* You hinted at another value proposition around ML and data. By collecting high-quality scans and building an inventory, you are also amassing a dataset that could be very valuable for \*\*training future models or analytics\*\*. For example, you could train a model to \*\*assess card condition\*\* (corners, centering, etc.) using your images, or a model to predict market value. Those are future projects, but the data you gather now (images \+ verified labels/grades) sets the stage for them. In the ML space, having your own well-labeled data is a big asset – and you’re creating that asset for free as a byproduct of inventorying your collection.  
      
\- \*\*No-turnkey solution – but yours is custom-fit:\*\* As your research file noted, there’s currently \*\*no turnkey solution that covers scanning, identification, grading, and inventory management all in one for high volumes\*\* . By building Cardmint in this way, you’re essentially creating a custom solution tailored to your needs. This gives you flexibility that off-the-shelf tools can’t offer and you’re not paying licensing fees for some enterprise software. The trade-off is the development time, but you’re leveraging AI pair-programmers (like Claude or GPT) to minimize that overhead.  
      
\- \*\*Monitoring and maintenance:\*\* Keep an eye on system performance. The MBP might get warm when running continuous ML; ensure it has good ventilation. The Fedora machine, if left on for long periods, should also be monitored (especially if it’s a laptop, ensure it doesn’t overheat with the camera usage). These are minor points, but taking care of the hardware will avoid unexpected costs (like repairs).  
      
\- \*\*Testing the entire pipeline:\*\* Before you go full steam scanning hundreds of cards, do a thorough test of the end-to-end pipeline with, say, 10 cards. Verify that images are captured properly, sent to MBP, identified correctly, and stored in the DB with all details. This dry run will help catch any bugs or slow points. It’s easier to adjust with a small batch than when you’re in the middle of scanning card \#500.  
      
\- \*\*Documentation:\*\* Document the steps and any scripts you write. This not only helps if you bring others on board in the future, but also helps if you step away from the project for a while and come back (or if something crashes and you need to recall how it’s set up). Documenting now is free and saves time later.  
    

  

This pipeline should meet your current needs while keeping operating costs essentially at zero. As your business scales and revenue comes in, you can then decide where to invest for improvements (be it better equipment, cloud services for customer-facing components, or even commercial APIs if you ever wanted to compare results). But the beauty of the proposed solution is that it gives you \*\*full control\*\* over the process without ongoing fees.

  

\#\# \*\*9. Step-by-Step Implementation Plan\*\*

  

Finally, to tie everything together, here’s a checklist of steps to implement this optimized pipeline:

1\. \*\*Set up capture environment (Fedora):\*\*  
      
    \- Ensure the Sony SDK is working for image capture on Fedora (which it is, after your hard work). Set the output directory for images (e.g. \~/card\_scans/).  
          
    \- Arrange consistent lighting and background for card photos to maximize image quality (test a few shots to check clarity).  
          
    \- (Optional) Write a small script or use existing SDK tools to automate capturing to file when you press a key, to streamline the manual capture process.  
          
      
2\. \*\*Prepare the MBP ML service:\*\*  
      
    \- Finish training your card identification model on the MBP (wait for the training to complete by Aug 21). Once ready, test it on a few sample images to ensure it outputs the expected predictions.  
          
    \- Create a Python script with Flask or FastAPI on the MBP. In the startup of this script, load the trained model into memory (so it’s ready to handle requests). Implement an /identify route that:  
          
        \- Receives an image (from a POST request).  
              
        \- Preprocesses it as needed (resizing, normalization consistent with training).  
              
        \- Runs the model to get identification results.  
              
        \- Returns the result in JSON (e.g. card name, and possibly additional info like set or confidence).  
              
          
    \- Test this script locally on the MBP (e.g., use curl or a small Python client to POST an image file to http://localhost:5000/identify and see that you get a correct response).  
          
    \- Once working, configure the MBP to have a static IP or local hostname. Test that from the Fedora machine you can reach the MBP (ping it, etc.).  
          
    \- Run the Flask/FastAPI app on the MBP, and try sending a test image from Fedora via curl to ensure networking is fine.  
          
      
3\. \*\*Set up the inventory database (MBP):\*\*  
      
    \- Decide on a database solution. For simplicity, you could start with SQLite (which is just a file on disk) if using it from a single process at a time. If you want multi-process access (e.g., MBP service and maybe other tools), a lightweight MySQL or Postgres on the MBP could be used.  
          
    \- Define the schema for your inventory: at minimum, fields for an ID, card name, possibly card set/number, maybe condition, and the image file path. You might also store a price or notes. For now, keep it basic.  
          
    \- Set up the DB and make sure you can connect to it. If using SQLite, it’s just a file. If MySQL/Postgres, create a database and user with appropriate privileges on MBP.  
          
    \- Write a function or API endpoint to insert new records. This could be inside the same MBP Flask app (e.g., after identification, the service could perform a DB insert). Or you could choose to have Fedora insert after it confirms the result. One approach: have the MBP return the identification to Fedora, and then Fedora calls a second endpoint like /addCard with the confirmed info to add to DB. Alternatively, the identification endpoint could add to DB immediately and return a success/failure.  
          
    \- Test adding a sample record to the DB and querying it. Make sure the images (file paths) it references are accessible.  
          
      
4\. \*\*Modify the Fedora review UI:\*\*  
      
    \- Incorporate a step to call the MBP API. If your Fedora UI is written in Python (for example, using Flask or a simple script), you can use the requests library to POST the image after capturing. If it’s a web UI with a front-end, you might have the backend do it after the file upload.  
          
    \- Add a “loading” indicator or message in the UI while waiting for the response from MBP, to improve user experience.  
          
    \- Display the returned card identification in the UI once received. Provide a way for you to confirm or edit it. Perhaps the UI can have an editable text field that is auto-filled with the predicted name (and maybe a dropdown for set). If it’s correct, you just hit “Confirm” or press Enter. If not, you can type/select the correct value.  
          
    \- On confirmation, trigger the inventory save. This could call an internal function or hit the MBP’s add-to-DB endpoint. Give some feedback like “Card saved\!” and then clear the UI for the next card (or ready the next slot).  
          
    \- Test this whole flow with a dummy image first (perhaps a known card) to ensure the UI properly waits for the MBP and updates the data.  
          
      
5\. \*\*Network and speed testing:\*\*  
      
    \- Time a few full runs. From pressing capture to seeing the result in UI, measure if it’s within \~3–5 seconds. If not, identify the slowest part (image capture, transfer, model inference, etc.) and optimize accordingly:  
          
        \- If capture is slow, check camera settings (maybe using a lower image format or disabling any unnecessary post-processing).  
              
        \- If transfer is slow, check network connectivity or switch to wired ethernet.  
              
        \- If inference is slow, consider whether the model can be optimized (e.g., use half-precision, or ensure you’re not using CPU unintentionally – the model should be on GPU).  
              
          
    \- Ensure the system is stable during continuous operation. Try scanning, say, 20 cards in a row and see if any memory issues or slowdowns occur (like memory leaks or GPU memory not clearing). The MBP should handle it, but it’s good to observe resource usage (you can watch Activity Monitor or top on MBP while it’s running to see CPU/GPU utilization).  
          
      
6\. \*\*Iterate and refine:\*\*  
      
    \- After these tests, refine any part of the pipeline that was problematic. Maybe you find that manually confirming each card is a bit slow – perhaps you could streamline UI inputs or add keyboard shortcuts to speed up confirmation. Or maybe the model had a few misidentifications – you could think about how to quickly correct those (like adding that drop-down of suggestions).  
          
    \- Make notes of any repeated errors to potentially update the model or handle them in code. For example, if the model always struggles with holographic cards due to glare, maybe you implement a quick rule like “if confidence \< X and card has holo pattern, ensure lighting or take another photo”.  
          
    \- Check that all data is being saved correctly in the DB, and that images are being stored without corruption.  
          
    \- If using the HTTP approach, consider logging the requests on MBP to a file – this helps debug if something fails (you’d see an error trace if the model crashes on a particular image, for instance).  
          
      
7\. \*\*Prepare for scale and backup:\*\*  
      
    \- Once the system is running smoothly for a handful of cards, you’re ready to scale up to your whole collection. Plan how you’ll physically handle the cards (to maintain that \~5-second rhythm – e.g., maybe having them sorted or queued in a box so you can quickly swap them under the camera).  
          
    \- As you scan in volume, periodically backup your data (images and DB) to the external NVMe or another backup (as discussed). You could automate this with a nightly sync script or just do it manually at the end of a session.  
          
    \- Monitor storage space on the MBP as images accumulate. 1 TB is a lot, but thousands of high-res images will consume tens of GB. It’s good to keep an eye so you don’t accidentally fill the disk. If it starts getting heavy, consider offloading older images to an archive (e.g., move older ones to the external drive but keep their records – you’d lose the ability to quickly pull them up in UI unless you plug the drive, but you’d still have them safe).  
          
    \- Keep the system updated: Ensure the Fedora and MBP both have necessary updates (but avoid major changes in the middle of a big project run). Especially, keep Python libraries up to date if they contain important performance fixes (e.g., newer PyTorch versions might improve MPS backend performance).  
          
    

  

By following this implementation plan, you’ll gradually build up the fully optimized pipeline. The end result will be a \*\*streamlined system\*\* where you simply place a card, click capture, glance at the screen to verify the auto-filled info, and move on to the next card – with all data being saved in an organized fashion.

\---

\*\*Sources:\*\*

\- Card identification and processing speed insights from \_Cardmint ML Analysis\_ , emphasizing the advantages of optimized neural networks over OCR and the benefits of GPU acceleration for \<1s inference times.  
      
\- Recommendations for Apple Silicon (M2) utilization and model fine-tuning (SmolVLM with Core ML/MLX) , supporting the plan to offload ML to the MBP for 1–3s processing per card.  
      
\- Discussion of current solutions and challenges in the trading card ML space , highlighting the need for custom pipelines (no turnkey system) and known difficulties with variant recognition that our approach can address with human verification.  
      
\- Commercial API performance (e.g., Ximilar’s 97% accuracy, \~1s per card) referenced for context – demonstrating that our target of similar accuracy and speed is achievable in-house, without the associated costs.  
      
\- Dataset information (TheFusion21 Pokémon card dataset \~13k images) and community accuracy range , which justify our model training approach and expected accuracy improvements for the MBP model.  
