import { useEffect } from "react";
import axios from "axios";
import { serverUrl } from "../App";
import { useDispatch, useSelector } from "react-redux";
import { setShopInMyCity } from "../redux/userSlice";

function useGetShopByCity() {
  const dispatch = useDispatch()
  const selectedCity = useSelector((state) => state.user.selectedCity);
  const currentCity = useSelector((state) => state.user.currentCity);
  const cityToUse = selectedCity || currentCity; // Fallback to currentCity if selectedCity not set
  
  useEffect(() => {
    if (!cityToUse || cityToUse.trim() === '') return; // Skip if city not available or empty
    const fetchShop = async () => {
      try {
        const result = await axios.get(`${serverUrl}/api/shop/get-by-city/${encodeURIComponent(cityToUse)}`, {
          withCredentials: true,
        });
       dispatch(setShopInMyCity(result.data))
      } catch (error) {
        console.log(error);
      }
    };
    fetchShop();
  }, [cityToUse]);
}

export default useGetShopByCity;
