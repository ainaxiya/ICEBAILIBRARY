"use client";

import { useEffect, useState } from "react";
import {
  REGION_COUNTRIES,
  type RegionNode,
  type RegionValue,
  regionCountryName,
} from "@/lib/regions";

// ─── 国家 / 省州 / 城市 / 区 四级联动下拉 ───
// 中国 → public/region/pca.json（省/市/区三级，约 1.9MB，首次使用懒加载）
// 其余 19 国 → public/region/<ISO2>.json（省/州 → 城市两级，按国家懒加载）
// 数据按国家分文件，进入页面只拉当前国家，不把全部行政区塞进首屏。

const selectCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 disabled:opacity-50";
const inputCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500";

const treeCache = new Map<string, RegionNode[]>();

async function loadRegionTree(countryCode: string): Promise<RegionNode[]> {
  const code = countryCode.toUpperCase();
  const cached = treeCache.get(code);
  if (cached) return cached;
  const url = code === "CN" ? "/region/pca.json" : `/region/${code}.json`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const d = (await r.json()) as RegionNode[];
    const tree = Array.isArray(d) ? d : [];
    treeCache.set(code, tree);
    return tree;
  } catch {
    treeCache.set(code, []);
    return [];
  }
}

export default function RegionCascade({
  value,
  onChange,
  fixed = false,
}: {
  value: RegionValue;
  onChange: (v: RegionValue) => void;
  fixed?: boolean;
}) {
  const [tree, setTree] = useState<RegionNode[]>([]);
  const [loading, setLoading] = useState(false);
  const selectW = fixed ? "w-full sm:w-[160px]" : "w-full";
  const districtW = fixed ? "w-full sm:w-[200px]" : "w-full";

  const countryCode = value.countryCode;
  const isCN = countryCode === "CN";

  useEffect(() => {
    if (!countryCode) {
      setTree([]);
      return;
    }
    let alive = true;
    setLoading(true);
    loadRegionTree(countryCode).then((t) => {
      if (alive) {
        setTree(t);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [countryCode]);

  const emit = (patch: Partial<RegionValue>) => {
    onChange({
      countryCode: value.countryCode,
      province: value.province,
      city: value.city,
      district: value.district,
      ...patch,
    });
  };

  const onCountry = (code: string) => {
    onChange({ countryCode: code, province: "", city: "", district: "" });
  };

  const provinceNode = tree.find((p) => p.name === value.province);
  // 直辖市：省下只有一个「市辖区」节点时自动锁定中间层
  const cityLocked =
    isCN && provinceNode?.children?.length === 1 ? provinceNode.children[0].name : "";
  const cityList = provinceNode?.children || [];
  const districtList =
    cityLocked && provinceNode?.children?.length === 1
      ? provinceNode.children[0].children || []
      : cityList.find((c) => c.name === value.city)?.children || [];

  return (
    <div className="space-y-2">
      <div className={fixed ? "flex flex-wrap gap-2" : "grid grid-cols-3 gap-2"}>
        <select
          value={countryCode}
          onChange={(e) => onCountry(e.target.value)}
          className={selectCls + " " + selectW}
          aria-label="国家 / 地区"
        >
          <option value="">国家 / 地区</option>
          {REGION_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          value={value.province}
          onChange={(e) => emit({ province: e.target.value, city: "", district: "" })}
          className={selectCls + " " + selectW}
          aria-label="省 / 州"
          disabled={!countryCode || loading}
        >
          <option value="">{loading ? "加载中…" : isCN ? "省份" : "省 / 州"}</option>
          {tree.map((p) => (
            <option key={p.code} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>

        {cityLocked ? (
          <select value={cityLocked} disabled className={selectCls + " " + selectW} aria-label="城市">
            <option>{cityLocked}</option>
          </select>
        ) : (
          <select
            value={value.city}
            onChange={(e) => emit({ city: e.target.value, district: "" })}
            className={selectCls + " " + selectW}
            aria-label="城市"
            disabled={!value.province || loading}
          >
            <option value="">{isCN ? "城市" : "城市"}</option>
            {cityList.map((c) => (
              <option key={c.code} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {isCN ? (
        <select
          value={value.district}
          onChange={(e) => emit({ district: e.target.value })}
          className={selectCls + " " + districtW}
          aria-label="区 / 县"
          disabled={!value.city || loading}
        >
          <option value="">区 / 县</option>
          {districtList.map((d) => (
            <option key={d.code} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={value.district}
          onChange={(e) => emit({ district: e.target.value.slice(0, 50) })}
          className={inputCls + " " + districtW}
          placeholder="区 / 郡（选填）"
          maxLength={50}
          aria-label="区 / 郡（选填）"
          disabled={!countryCode}
        />
      )}

      {countryCode && !isCN && (
        <p className="text-xs text-zinc-500">
          已选：{regionCountryName(countryCode)}
          {value.province ? ` · ${value.province}` : ""}
          {value.city ? ` · ${value.city}` : ""}
        </p>
      )}
    </div>
  );
}
