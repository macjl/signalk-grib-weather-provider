FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
# python3-numpy from distro (ARM64 wheel, no build); eccodes bundles its own C library
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends python3 python3-numpy python3-pip \
    && pip3 install eccodes --break-system-packages --no-cache-dir \
    && rm -rf /var/lib/apt/lists/*
COPY grib2cache.py /app/grib2cache.py
WORKDIR /app
