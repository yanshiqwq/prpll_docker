FROM nvidia/cuda:12.8.0-runtime-ubuntu22.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/prpll
RUN wget -O prpll https://download.mersenne.ca/PRPLL-NTT/2026-04-25/prpll-ntt_linux-cuda_20260425 \
  && chmod +x prpll

ENTRYPOINT ["/opt/prpll/prpll"]